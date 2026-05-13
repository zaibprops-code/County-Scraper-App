// ============================================================
// /api/discover-endpoint — One-time diagnostic
//
// Hit this URL once from your browser after deploying:
//   https://your-app.vercel.app/api/discover-endpoint
//
// It runs on Vercel (which CAN reach gis.hcpafl.org) and:
//   1. Fetches the ArcGIS REST services catalog
//   2. Lists every available service and layer
//   3. Tests each layer for OWN1 field (owner name)
//   4. Returns which service+layer has property owner data
//
// Once you see the working service name in the response,
// paste it as HCPA_ARCGIS_SERVICE in your Vercel env vars.
// ============================================================

import { NextResponse } from "next/server";
import axios from "axios";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE = "https://gis.hcpafl.org";
const PROXY = `${BASE}/HPAProxy/proxy.ashx`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
};

interface ServiceItem {
  name: string;
  type: string;
  url?: string;
}
interface FolderResponse {
  services?: ServiceItem[];
  folders?: string[];
  error?: { code: number; message: string };
}
interface LayerInfo {
  id: number;
  name: string;
  fields?: Array<{ name: string; type: string }>;
}
interface MapServerInfo {
  layers?: LayerInfo[];
  error?: { code: number; message: string };
}

async function fetchJson<T>(url: string, label: string): Promise<{ data: T | null; status: number; error?: string }> {
  try {
    const resp = await axios.get<T>(url, {
      timeout: 8000,
      headers: HEADERS,
      validateStatus: () => true,
    });
    console.log(`[Discover] ${label}: HTTP ${resp.status}`);
    if (resp.status !== 200) {
      const body = JSON.stringify(resp.data).slice(0, 200);
      return { data: null, status: resp.status, error: body };
    }
    return { data: resp.data as T, status: resp.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Discover] ${label} EXCEPTION: ${msg}`);
    return { data: null, status: 0, error: msg };
  }
}

export async function GET(): Promise<NextResponse> {
  console.log("[Discover] ===== START =====");
  const results: Record<string, unknown> = {};

  // ---- Step 1: Fetch ArcGIS services root catalog ----
  console.log("[Discover] Step 1: fetching services catalog...");
  const catalogUrl = `${BASE}/arcgis/rest/services?f=json`;
  const catalog = await fetchJson<FolderResponse>(catalogUrl, "catalog");

  results.step1_catalog_url = catalogUrl;
  results.step1_catalog_status = catalog.status;
  results.step1_catalog_error = catalog.error;
  results.step1_catalog_data = catalog.data;

  // ---- Step 2: Try HPAProxy pattern ----
  console.log("[Discover] Step 2: testing HPAProxy...");
  const proxyTestUrl = `${PROXY}?${BASE}/arcgis/rest/services?f=json`;
  const proxyTest = await fetchJson<FolderResponse>(proxyTestUrl, "proxy_catalog");

  results.step2_proxy_url = proxyTestUrl;
  results.step2_proxy_status = proxyTest.status;
  results.step2_proxy_error = proxyTest.error;
  results.step2_proxy_services = proxyTest.data?.services?.slice(0, 20);

  // ---- Step 3: If catalog returned services, test each for OWN1 field ----
  const services: ServiceItem[] = [];
  if (catalog.data?.services) services.push(...catalog.data.services);
  if (proxyTest.data?.services) services.push(...proxyTest.data.services);

  console.log(`[Discover] Found ${services.length} services in catalog`);
  results.step3_services_found = services.map((s) => `${s.name} (${s.type})`);

  const testedLayers: Array<{
    service: string;
    layer: number;
    url: string;
    hasOWN1: boolean;
    status: number;
    sampleOwner?: string;
    error?: string;
  }> = [];

  // Test MapServer/FeatureServer services that could contain parcels
  const parcelKeywords = /parcel|property|owner|hpa|layer|real.?estate/i;
  const candidateServices = services
    .filter((s) => parcelKeywords.test(s.name) && (s.type === "MapServer" || s.type === "FeatureServer"))
    .slice(0, 8); // limit to avoid timeout

  console.log(`[Discover] Testing ${candidateServices.length} candidate services for OWN1`);

  for (const svc of candidateServices) {
    const svcUrl = `${BASE}/arcgis/rest/services/${svc.name}/${svc.type}?f=json`;
    console.log(`[Discover] Fetching layer list: ${svcUrl}`);
    const svcInfo = await fetchJson<MapServerInfo>(svcUrl, `svc_${svc.name}`);

    const layers = svcInfo.data?.layers ?? [];
    console.log(`[Discover] ${svc.name}: ${layers.length} layers`);

    for (const layer of layers.slice(0, 3)) {
      const queryUrl = `${BASE}/arcgis/rest/services/${svc.name}/${svc.type}/${layer.id}/query?where=UPPER(OWN1) LIKE '%25SMITH%25'&outFields=OWN1,PHYCITY,PHYZIP&returnGeometry=false&resultRecordCount=2&f=json`;
      console.log(`[Discover] Testing layer ${layer.id} "${layer.name}": ${queryUrl}`);

      const qResult = await fetchJson<{
        features?: Array<{ attributes: Record<string, unknown> }>;
        error?: { code: number; message: string };
      }>(queryUrl, `layer_${svc.name}_${layer.id}`);

      const features = qResult.data?.features ?? [];
      const hasOWN1 = features.length > 0 && features[0].attributes?.["OWN1"] !== undefined;
      const sampleOwner = hasOWN1 ? String(features[0].attributes["OWN1"]) : undefined;

      if (hasOWN1) {
        console.log(`[Discover] ✓ FOUND OWN1 in ${svc.name}/${layer.id}: "${sampleOwner}"`);
      }

      testedLayers.push({
        service: `${svc.name}/${svc.type}`,
        layer: layer.id,
        url: queryUrl,
        hasOWN1,
        status: qResult.status,
        sampleOwner,
        error: qResult.error,
      });
    }
  }

  results.step3_tested_layers = testedLayers;
  results.step3_working_layers = testedLayers.filter((l) => l.hasOWN1);

  // ---- Step 4: If catalog unreachable, try known service names directly ----
  if (services.length === 0) {
    console.log("[Discover] Step 4: catalog empty — probing known service names directly");

    const knownNames = [
      "Property", "Parcels", "parcels", "PropertySearch",
      "HPA_Layers", "HPA", "Public", "HCPA", "Parcel",
    ];

    const directProbes: Array<{ url: string; status: number; features: number; error?: string }> = [];

    for (const name of knownNames) {
      for (const type of ["MapServer", "FeatureServer"]) {
        const url = `${BASE}/arcgis/rest/services/${name}/${type}/0/query?where=UPPER(OWN1) LIKE '%25SMITH%25'&outFields=OWN1,PHYCITY&returnGeometry=false&resultRecordCount=1&f=json`;
        const r = await fetchJson<{ features?: unknown[]; error?: { code: number; message: string } }>(url, `probe_${name}`);
        const features = (r.data?.features ?? []).length;
        if (features > 0 || (r.status === 200 && !r.data?.error)) {
          directProbes.push({ url, status: r.status, features });
          console.log(`[Discover] ✓ ${name}/${type}/0: HTTP ${r.status} features=${features}`);
        } else {
          directProbes.push({ url, status: r.status, features: 0, error: r.error ?? r.data?.error?.message });
        }
      }
    }

    results.step4_direct_probes = directProbes;
    results.step4_working = directProbes.filter((p) => p.features > 0);
  }

  // ---- Step 5: Test HPAProxy with direct service probe ----
  console.log("[Discover] Step 5: testing HPAProxy with direct service queries");
  const proxyProbes: Array<{ url: string; status: number; features: number; error?: string }> = [];
  const proxyServices = ["Property", "Parcels", "HPA_Layers", "PropertySearch"];

  for (const name of proxyServices) {
    const innerUrl = `${BASE}/arcgis/rest/services/${name}/MapServer/0/query?where=UPPER(OWN1) LIKE '%25SMITH%25'&outFields=OWN1,PHYCITY&returnGeometry=false&resultRecordCount=1&f=json`;
    const proxyUrl = `${PROXY}?${innerUrl}`;
    const r = await fetchJson<{ features?: unknown[]; error?: unknown }>(proxyUrl, `proxy_${name}`);
    const features = (r.data?.features ?? []).length;
    proxyProbes.push({ url: proxyUrl, status: r.status, features, error: r.error });
    if (features > 0) {
      console.log(`[Discover] ✓ HPAProxy + ${name}: HTTP ${r.status} features=${features}`);
    }
  }

  results.step5_proxy_probes = proxyProbes;
  results.step5_working_proxy = proxyProbes.filter((p) => p.features > 0);

  // ---- Summary ----
  const workingDirect = (results.step3_working_layers as unknown[]) ?? [];
  const workingProxy = (results.step5_working_proxy as unknown[]) ?? [];
  const totalWorking = workingDirect.length + workingProxy.length;

  results.SUMMARY = {
    working_endpoints_found: totalWorking,
    recommendation:
      totalWorking > 0
        ? "Set HCPA_ARCGIS_SERVICE env var to the working service name shown above"
        : "No working endpoints found from Vercel IP. HCPA may require IP whitelisting or session auth.",
    next_step:
      totalWorking > 0
        ? "Copy the 'service' value from step3_working_layers and set as HCPA_ARCGIS_SERVICE in Vercel env vars, then redeploy"
        : "Contact HCPA GIS department or use alternative data source",
  };

  console.log("[Discover] ===== END =====");
  console.log("[Discover] Working endpoints:", totalWorking);

  return NextResponse.json(results, { status: 200 });
}
