#!/usr/bin/env python3
"""Synthetic, dependency-free energy scenario explorer for a CoCalc demo."""
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


DEMAND = [28, 26, 25, 24, 25, 30, 40, 50, 56, 62, 66, 70,
          74, 78, 80, 82, 86, 92, 94, 84, 68, 54, 42, 34]
SOLAR = [0, 0, 0, 0, 0, 2, 10, 26, 44, 62, 76, 88,
         94, 90, 78, 62, 42, 22, 8, 0, 0, 0, 0, 0]
SCENARIOS = {
    "balanced": ("Base case", 100, 100),
    "efficient": ("Lower demand", 80, 100),
    "solar": ("More solar", 100, 150),
}


def validate_series(values):
    if not isinstance(values, list) or len(values) != 24:
        raise ValueError("Expected exactly 24 hourly values")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or
           not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("Hourly values must be finite, nonnegative numbers")


def scenario(mode, demand=None, solar=None):
    if mode not in SCENARIOS:
        raise ValueError("Unknown scenario")
    demand = DEMAND if demand is None else demand
    solar = SOLAR if solar is None else solar
    validate_series(demand)
    validate_series(solar)
    label, demand_percent, solar_percent = SCENARIOS[mode]
    d = [round(v * demand_percent / 100, 4) for v in demand]
    s = [round(v * solar_percent / 100, 4) for v in solar]
    grid = [round(max(a - b, 0), 4) for a, b in zip(d, s)]
    used = [min(a, b) for a, b in zip(d, s)]
    total = sum(d)
    return {
        "mode": mode, "label": label, "synthetic": True,
        "demand": d, "solar": s, "grid": grid,
        "metrics": {
            "demand_kwh": round(total, 1),
            "solar_kwh": round(sum(s), 1),
            "grid_kwh": round(sum(grid), 1),
            "solar_used_kwh": round(sum(used), 1),
            "coverage_percent": round(sum(used) / total * 100, 1) if total else 0,
            "peak_grid_kw": round(max(grid), 1),
        },
    }


PAGE = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Energy scenario explorer · Synthetic demonstration</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#14233d;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}button{font:inherit}button:focus-visible,summary:focus-visible{outline:3px solid #146adb;outline-offset:4px}header{background:#132440;color:white}.top{max-width:1450px;margin:auto;padding:17px 40px;display:flex;align-items:center;justify-content:space-between;gap:20px}.identity{font-size:17px;font-weight:750;letter-spacing:-.4px}.identity span{color:#80d4ef;font-weight:450;margin-left:9px}.tag{font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;border:1px solid #51617b;border-radius:5px;padding:4px 9px;color:#dce9ff}main{max-width:1450px;padding:35px 40px 28px;margin:auto}.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;margin-bottom:25px}.eyebrow{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:1.6px;color:#546b88;margin:0 0 7px}h1{font-size:clamp(27px,3vw,39px);line-height:1.13;letter-spacing:-1.3px;margin:0 0 10px;font-weight:720}.lede{margin:0;color:#52647b;max-width:670px;font-size:15px}.sample{font-size:12px;line-height:1.5;color:#64728b;white-space:nowrap;text-align:right}.controls{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:24px 0 20px}.choices{display:flex;padding:4px;background:#e4eaf2;border-radius:9px;gap:4px;flex-wrap:wrap}.choices button{border:0;background:transparent;color:#40546c;padding:9px 17px;border-radius:6px;font-size:13px;font-weight:650;cursor:pointer}.choices button[aria-pressed=true]{background:#fff;color:#142b53;box-shadow:0 1px 4px #16243e1a}.choices button:hover{background:#ffffffb8}.scenario-note{font-size:12px;color:#52647b;text-align:right;max-width:350px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:22px}.metric{border:1px solid #dce4ee;border-radius:12px;background:#fff;padding:19px 22px;position:relative;overflow:hidden}.metric::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent)}.metric-title{margin:0;font-size:12px;font-weight:600;color:#52647b}.number{font-size:35px;font-weight:710;line-height:1.3;letter-spacing:-1.2px;color:#142b4c}.unit{font-size:16px;letter-spacing:0;font-weight:500;color:#64728b;margin-left:5px}.metric-note{font-size:11px;color:#617189}.body-grid{display:grid;grid-template-columns:minmax(0,1fr) 275px;gap:20px}.panel{background:#fff;border:1px solid #dce4ee;border-radius:12px;min-width:0}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;padding:21px 23px 5px}h2{font-size:16px;letter-spacing:-.3px;margin:0;font-weight:700}.caption{font-size:12px;color:#607188;margin:4px 0 0}.legend{display:flex;gap:16px;font-size:11px;color:#40546c;padding-top:4px;flex-wrap:wrap}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:18px;height:3px;border-radius:3px;background:var(--color);display:block}.chart-wrap{padding:0 12px;overflow-x:auto}#chart{display:block;width:100%;height:auto;min-width:500px}.chart-footer{margin:0 24px 17px;font-size:11px;color:#64728b}.sidebar{padding:23px;background:linear-gradient(150deg,#edf6ff,#f7faff);border-color:#d6e4f2}.sidebar h2{font-size:18px;line-height:1.3}.sidebar p{font-size:13px;color:#40546c;margin:11px 0 21px}.comparison{border-top:1px solid #cfdfef;padding:16px 0 0}.compare-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#526c88}.compare-value{font-size:30px;letter-spacing:-1px;font-weight:720;margin:4px 0;color:#11635b}.compare-text{font-size:12px!important;margin:0!important}.small-stat{padding-top:20px;margin-top:20px;border-top:1px solid #cfdfef;display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#40546c}.small-stat b{color:#203652}.heat-panel{margin-top:20px;padding:20px 23px}.heat-heading{display:flex;justify-content:space-between;align-items:baseline;gap:15px}.heat-heading p{font-size:11px;color:#64728b;margin:0}.heat{display:grid;grid-template-columns:repeat(24,minmax(0,1fr));gap:4px;margin:16px 0 7px}.heat-cell{height:34px;border-radius:4px;display:grid;place-items:center;font-size:10px;font-weight:650}.heat-axis{display:flex;justify-content:space-between;font-size:10px;color:#63748a}.bottom-note{margin:17px 0 0;font-size:11px;color:#617189}.bottom-note strong{color:#40546c}details{margin-top:16px;border:1px solid #dce4ee;background:#fff;border-radius:10px;padding:12px 16px}summary{cursor:pointer;font-size:12px;font-weight:650}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;margin-top:12px}caption{text-align:left;color:#52647b;margin:6px 0}th,td{text-align:right;padding:6px 10px;border-bottom:1px solid #e6ecf3}th:first-child,td:first-child{text-align:left}#status{min-height:18px;color:#943719;font-size:12px;margin:5px 0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}button[disabled]{opacity:.6;cursor:progress}
@media(max-width:1000px){.body-grid{grid-template-columns:minmax(0,1fr)}.sidebar{display:grid;grid-template-columns:1.4fr 1fr;gap:0 30px}.sidebar .comparison{border:0;padding:0}.sidebar .small-stat{grid-column:1/-1}.intro{align-items:flex-start}.sample{display:none}}
@media(max-width:620px){.top{padding:15px 18px}.identity{font-size:15px}.identity span{display:none}.tag{font-size:9px}main{padding:25px 18px}.intro{margin-bottom:17px}.controls{align-items:flex-start;flex-direction:column}.scenario-note{text-align:left}.choices{width:100%}.choices button{flex:1;padding:9px 7px;font-size:11px}.metrics{gap:9px}.metric{padding:13px 10px}.number{font-size:25px}.unit{font-size:11px;margin-left:3px}.metric-title{font-size:10px;min-height:30px}.metric-note{font-size:10px}.panel-head{flex-direction:column;padding:17px 16px 7px}.legend{gap:20px}.sidebar{display:block;padding:20px}.sidebar .comparison{border-top:1px solid #cfdfef;padding-top:14px}.heat-panel{padding:17px 16px}.heat-heading{align-items:flex-start;flex-direction:column;gap:4px}.heat{gap:2px}.heat-cell{height:28px;font-size:0}.heat-cell:nth-child(4n + 1){font-size:9px}.bottom-note{font-size:10px}}
</style></head><body>
<header><div class="top"><div class="identity">ENERGY LAB<span>Scenario explorer</span></div><span class="tag">Synthetic demonstration</span></div></header>
<main>
<div class="intro"><div><p class="eyebrow">From data to a decision</p><h1>See what changes your energy demand.</h1><p class="lede">Compare three simple scenarios across one fictional day. Explore how demand and solar generation change the energy drawn from the grid.</p></div><div class="sample">24 hourly intervals<br>No location or customer data</div></div>
<div class="controls"><div class="choices" role="group" aria-label="Choose an energy scenario"><button type="button" data-mode="balanced" aria-pressed="true">Base case</button><button type="button" data-mode="efficient" aria-pressed="false">Lower demand</button><button type="button" data-mode="solar" aria-pressed="false">More solar</button></div><div class="scenario-note" id="scenario-note">Baseline synthetic demand and solar generation.</div></div>
<div class="metrics" aria-label="Scenario results">
<div class="metric" style="--accent:#397beb"><p class="metric-title">Energy drawn from the grid</p><div class="number"><span id="grid-total">726</span><span class="unit">kWh</span></div><div class="metric-note">Across the 24-hour sample</div></div>
<div class="metric" style="--accent:#18a591"><p class="metric-title">Demand met by solar</p><div class="number"><span id="coverage">47.0</span><span class="unit">%</span></div><div class="metric-note">Used in the hour it is generated</div></div>
<div class="metric" style="--accent:#efac41"><p class="metric-title">Peak draw from the grid</p><div class="number"><span id="peak">86</span><span class="unit">kW</span></div><div class="metric-note">Highest hourly average</div></div>
</div>
<div class="body-grid"><section class="panel" aria-labelledby="plot-heading"><div class="panel-head"><div><h2 id="plot-heading">The shape of a day</h2><p class="caption">Hourly average power · kW</p></div><div class="legend"><span><i style="--color:#397beb"></i>Demand</span><span><i style="--color:#eea42e"></i>Solar generation</span></div></div><div class="chart-wrap"><svg id="chart" viewBox="0 0 900 330" role="img" aria-labelledby="chart-title chart-desc"></svg></div><p class="chart-footer">Each point represents a one-hour average. Values between points are connected for readability.</p></section>
<aside class="panel sidebar" aria-labelledby="insight-heading"><div><p class="eyebrow">Read the result</p><h2 id="insight-heading">Timing matters as much as output.</h2><p id="insight">Solar peaks near midday. The highest grid draw arrives later, as solar generation falls.</p></div><div class="comparison"><div class="compare-label">Grid energy vs. base case</div><div class="compare-value" id="difference">No change</div><p class="compare-text" id="difference-note">Choose another scenario to compare.</p></div><div class="small-stat"><span>Total demand</span><b id="demand-total">1,370 kWh</b></div><div class="small-stat"><span>Solar generation</span><b id="solar-total">704 kWh</b></div></aside></div>
<section class="panel heat-panel" aria-labelledby="heat-heading"><div class="heat-heading"><h2 id="heat-heading">When the grid does the work</h2><p>Darker blue = higher grid draw · kW</p></div><div id="heat" class="heat" role="img" aria-label="Hourly grid draw; exact values are in the data table below"></div><div class="heat-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div></section>
<p class="bottom-note"><strong>Model boundary:</strong> These are invented hourly values, not a forecast. No batteries, export credits, losses, prices or weather model are included. Surplus solar is not carried into another hour.</p>
<p id="status" role="status" aria-live="polite"></p>
<details><summary>Inspect the 24 hourly values</summary><div class="table-wrap"><table><caption id="table-caption">Base case · hourly averages in kW; one hour per row</caption><thead><tr><th scope="col">Hour</th><th scope="col">Demand (kW)</th><th scope="col">Solar (kW)</th><th scope="col">Grid (kW)</th></tr></thead><tbody id="rows"></tbody></table></div></details>
<noscript><p>JavaScript is required for the interactive chart. The initial summary shows the base case. The JSON data endpoint is <a href="api/scenario?mode=balanced">api/scenario?mode=balanced</a>.</p></noscript>
</main><script>
"use strict";
const initial=__INITIAL__;
const notes={balanced:"Baseline synthetic demand and solar generation.",efficient:"Demand reduced by 20% in every hour; solar unchanged.",solar:"Solar generation increased by 50%; demand unchanged."};
const fmt=n=>Number(n).toLocaleString("en-US",{maximumFractionDigits:1});
function render(data){
 const m=data.metrics;
 document.querySelector("#grid-total").textContent=fmt(m.grid_kwh);
 document.querySelector("#coverage").textContent=m.coverage_percent.toFixed(1);
 document.querySelector("#peak").textContent=fmt(m.peak_grid_kw);
 document.querySelector("#demand-total").textContent=fmt(m.demand_kwh)+" kWh";
 document.querySelector("#solar-total").textContent=fmt(m.solar_kwh)+" kWh";
 document.querySelector("#scenario-note").textContent=notes[data.mode];
 document.querySelectorAll("[data-mode]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.mode===data.mode)));
 const saved=initial.metrics.grid_kwh-m.grid_kwh;
 document.querySelector("#difference").textContent=saved===0?"No change":fmt(saved)+" kWh less";
 document.querySelector("#difference-note").textContent=saved===0?"Choose another scenario to compare.":(saved/initial.metrics.grid_kwh*100).toFixed(1)+"% less grid energy in this synthetic day.";
 document.querySelector("#insight").textContent=data.mode==="solar"?"More midday solar creates a larger surplus, but does not eliminate the evening grid draw. This model has no storage.":data.mode==="efficient"?"Lower demand reduces grid draw throughout the day, including the evening hours when solar is unavailable.":"Solar peaks near midday. The highest grid draw arrives later, as solar generation falls.";
 const x=i=>60+i*35.15,y=v=>274-v/160*222;
 const path=values=>values.map((v,i)=>(i?"L":"M")+x(i).toFixed(2)+","+y(v).toFixed(2)).join(" ");
 const line=path(data.solar),area=line+" L"+x(23)+",274 L60,274 Z";
 let svg='<title id="chart-title">'+data.label+': demand and solar generation</title><desc id="chart-desc">Solar rises near midday and demand peaks in the evening. '+m.grid_kwh+' kWh drawn from the grid. Exact hourly data is available below.</desc><defs><linearGradient id="sun-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffc968" stop-opacity=".65"/><stop offset="100%" stop-color="#ffe9be" stop-opacity=".15"/></linearGradient></defs>';
 for(let v=0;v<=160;v+=40){svg+='<line x1="60" y1="'+y(v)+'" x2="870" y2="'+y(v)+'" stroke="#e4eaf2" stroke-dasharray="3 5"/><text x="43" y="'+(y(v)+4)+'" text-anchor="end" fill="#75849a" font-size="12">'+v+'</text>';}
 for(const i of [0,4,8,12,16,20,23])svg+='<text x="'+x(i)+'" y="302" text-anchor="middle" fill="#75849a" font-size="12">'+String(i).padStart(2,"0")+':00</text>';
 svg+='<path d="'+area+'" fill="url(#sun-fill)"/><path d="'+line+'" fill="none" stroke="#e8a030" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="'+path(data.demand)+'" fill="none" stroke="#397beb" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>';
 [8,12,18].forEach(i=>{svg+='<circle cx="'+x(i)+'" cy="'+y(data.demand[i])+'" r="4" fill="white" stroke="#397beb" stroke-width="2"/>';});
 document.querySelector("#chart").innerHTML=svg;
 document.querySelector("#heat").innerHTML=data.grid.map((v,i)=>{const a=.09+.84*Math.min(v/100,1);return '<div class="heat-cell" style="background:rgba(39,99,192,'+a+');color:'+(a>.55?'white':'#22416d')+'" title="'+String(i).padStart(2,'0')+':00: '+fmt(v)+' kW">'+fmt(v)+'</div>';}).join('');
 document.querySelector("#table-caption").textContent=data.label+" · hourly averages in kW; one hour per row";
 document.querySelector("#rows").innerHTML=data.demand.map((v,i)=>'<tr><th scope="row">'+String(i).padStart(2,'0')+':00</th><td>'+fmt(v)+'</td><td>'+fmt(data.solar[i])+'</td><td>'+fmt(data.grid[i])+'</td></tr>').join('');
}
render(initial);
document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",async()=>{
 const buttons=[...document.querySelectorAll("[data-mode]")];
 buttons.forEach(b=>b.disabled=true);
 document.querySelector("#status").textContent="Calculating scenario…";
 try{
  const base=location.pathname.endsWith("/")?location.pathname:location.pathname+"/";
  const response=await fetch(base+"api/scenario?mode="+encodeURIComponent(button.dataset.mode),{cache:"no-store"});
  if(!response.ok)throw new Error("HTTP "+response.status);
  const data=await response.json();render(data);
  document.querySelector("#status").textContent=data.label+": "+fmt(data.metrics.grid_kwh)+" kWh from the grid; "+data.metrics.coverage_percent.toFixed(1)+"% of demand met by solar.";
 }catch(error){document.querySelector("#status").textContent="The scenario could not be loaded. The previous result is still shown. Try again.";}
 finally{buttons.forEach(b=>b.disabled=false);button.focus();}
}));
</script></body></html>'''


def response_for(target):
    parsed = urlsplit(target)
    if parsed.path == "/health":
        return 200, "text/plain; charset=utf-8", b"ok\n"
    if parsed.path == "/":
        return 200, "text/html; charset=utf-8", PAGE.replace(
            "__INITIAL__", json.dumps(scenario("balanced"))).encode()
    if parsed.path == "/api/scenario":
        try:
            query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
            if set(query) != {"mode"} or len(query["mode"]) != 1:
                raise ValueError("Expected one scenario mode")
            data = scenario(query["mode"][0])
            return 200, "application/json; charset=utf-8", json.dumps(data).encode()
        except ValueError as error:
            return 400, "application/json; charset=utf-8", json.dumps({"error": str(error)}).encode()
    return 404, "text/plain; charset=utf-8", b"Not found\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code, mime, body = response_for(self.path)
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def self_test():
    import unittest

    class ExplorerTests(unittest.TestCase):
        def test_exact_base_aggregate(self):
            self.assertEqual(scenario("balanced")["metrics"], {
                "demand_kwh": 1370.0, "solar_kwh": 704.0, "grid_kwh": 726.0,
                "solar_used_kwh": 644.0, "coverage_percent": 47.0, "peak_grid_kw": 86.0,
            })

        def test_lower_demand_interaction(self):
            m = scenario("efficient")["metrics"]
            self.assertEqual((m["grid_kwh"], m["coverage_percent"], m["peak_grid_kw"]),
                             (536.0, 51.1, 67.2))
            self.assertEqual(726.0 - m["grid_kwh"], 190.0)

        def test_more_solar_interaction(self):
            m = scenario("solar")["metrics"]
            self.assertEqual((m["grid_kwh"], m["coverage_percent"], m["peak_grid_kw"]),
                             (637.0, 53.5, 84.0))

        def test_hourly_energy_balance(self):
            for mode in SCENARIOS:
                data = scenario(mode)
                for d, s, g in zip(data["demand"], data["solar"], data["grid"]):
                    self.assertAlmostEqual(d, g + min(s, d))
                    self.assertGreaterEqual(g, 0)

        def test_corrupt_inputs_rejected(self):
            for bad in [[], [1] * 23, [True] * 24, ["1"] * 24,
                        [float("nan")] * 24, [float("inf")] * 24, [-1] * 24, None]:
                with self.subTest(value=repr(bad)[:25]), self.assertRaises(ValueError):
                    validate_series(bad)

        def test_invalid_request_rejected(self):
            for query in ["", "mode=", "mode=unknown", "mode=solar&mode=balanced",
                          "mode=balanced&other=1", "mode"]:
                self.assertEqual(response_for("/api/scenario?" + query)[0], 400)
            self.assertEqual(response_for("/missing")[0], 404)

        def test_render_and_health(self):
            code, mime, body = response_for("/")
            self.assertEqual(code, 200)
            self.assertIn("text/html", mime)
            self.assertNotIn(b"__INITIAL__", body)
            self.assertIn(b"Synthetic demonstration", body)
            self.assertEqual(response_for("/health")[2], b"ok\n")

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ExplorerTests))
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"Synthetic energy explorer listening on {host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
