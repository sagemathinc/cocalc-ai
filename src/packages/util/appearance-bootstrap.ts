/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_SYSTEM_QUERY,
} from "./appearance";
import { appearanceStyleSheet } from "./appearance-palette";

// Kept as source, not Function.toString(): instrumentation/minification must not
// introduce references to the build process into the standalone browser script.
// Parity tests compare this bootstrap with the runtime preference resolver.
export function appearanceBootstrapScript(
  legacy?: "essential" | "scratchpad",
): string {
  return `(function(){
function preference(v){return v==="system"||v==="light"||v==="dark"?v:undefined}
function read(k){try{return localStorage.getItem(k)}catch(e){return null}}
function record(k){try{var v=JSON.parse(read(k));return v&&v.version===1&&preference(v.preference)&&(v.account_id==null||typeof v.account_id==="string")?v:null}catch(e){return null}}
var accountId,matched=-1;
try{document.cookie.split(";").forEach(function(item){
var i=item.indexOf("=");if(i<0)return;
try{var n=decodeURIComponent(item.slice(0,i).trim());if(!n.endsWith("account_id"))return;
var b=n.slice(0,-10).replace(/\\/$/,"");
if(b&&(!b.startsWith("/")||(location.pathname!==b&&!location.pathname.startsWith(b+"/"))))return;
if(b.length>matched){accountId=decodeURIComponent(item.slice(i+1));matched=b.length}}
catch(e){} })}catch(e){}
var a=record(${JSON.stringify(APPEARANCE_ACCOUNT_STORAGE_KEY)}),v=record(${JSON.stringify(APPEARANCE_STORAGE_KEY)});
var p=accountId&&a&&a.account_id===accountId?a.preference:v&&!v.account_id?v.preference:undefined;
if(!p&&${JSON.stringify(legacy ?? "")}==="essential")p=preference(read("cocalc-essential-theme"));
if(!p&&${JSON.stringify(legacy ?? "")}==="scratchpad"){var old=read("cocalc-scratchpad-dark-mode");p=old==="1"?"dark":old==="0"?"light":undefined}
p=p||"system";
var dark=false;try{dark=window.matchMedia(${JSON.stringify(APPEARANCE_SYSTEM_QUERY)}).matches}catch(e){}
var mode=p==="system"?(dark?"dark":"light"):p;
document.documentElement.setAttribute("data-cocalc-theme",mode);
document.documentElement.style.colorScheme=mode;
})();`;
}

export function appearanceHeadHtml(
  legacy?: "essential" | "scratchpad",
): string {
  return `<meta name="color-scheme" content="light dark"><style id="cocalc-appearance-tokens">${appearanceStyleSheet()}</style><script>${appearanceBootstrapScript(legacy)}</script>`;
}
