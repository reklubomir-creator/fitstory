/* RADAR HUBEŇOUR: consent-based GA4 tracking and owner-only GA4 Data API dashboard. */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const measurement=window.RADAR_FIREBASE_CONFIG?.measurementId;
const consentKey='radar-analytics-consent-v1';
const clientKey='radar-ga4-oauth-client';
const propertyKey='radar-ga4-property';
let tokenClient=null,accessToken=null;
function showStatus(message){const el=$('analyticsStatus');if(el)el.textContent=message}
function addScript(url){
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=url;script.async=true;script.onload=resolve;script.onerror=()=>reject(Error('Nepodařilo se načíst knihovnu Google.'));document.head.appendChild(script);
  });
}
async function startTracking(){
  if(!measurement||window.radarGtagStarted)return;
  window.radarGtagStarted=true;
  window.dataLayer=window.dataLayer||[];
  window.gtag=function(){window.dataLayer.push(arguments)};
  window.gtag('js',new Date());
  window.gtag('config',measurement,{anonymize_ip:true});
  await addScript('https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(measurement));
}
function consent(choice){
  try{localStorage.setItem(consentKey,choice)}catch(_){}
  const banner=$('analyticsConsent');if(banner)banner.hidden=true;
  if(choice==='yes')startTracking().catch(()=>{});
}
$('analyticsAllow')?.addEventListener('click',()=>consent('yes'));
$('analyticsDecline')?.addEventListener('click',()=>consent('no'));
$('analyticsReset')?.addEventListener('click',()=>{
  try{localStorage.removeItem(consentKey)}catch(_){}
  $('analyticsConsent').hidden=false;
  showStatus('Volbu měření můžeš změnit v panelu dole na stránce.');
});
let existing=null;try{existing=localStorage.getItem(consentKey)}catch(_){}
if(existing==='yes')startTracking().catch(()=>{});
else if(existing!=='no')$('analyticsConsent').hidden=false;
$('gaClientId').value=localStorage.getItem(clientKey)||'';
$('gaPropertyId').value=localStorage.getItem(propertyKey)||'';
function saveConfig(){
  const client=$('gaClientId').value.trim(),property=$('gaPropertyId').value.trim();
  if(!/^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(client))throw Error('Zadej platné OAuth Client ID pro webovou aplikaci.');
  if(!/^\d+$/.test(property))throw Error('Zadej číselné ID služby Google Analytics 4.');
  localStorage.setItem(clientKey,client);localStorage.setItem(propertyKey,property);
  return {client,property};
}
function localDate(d){return d.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric',year:'numeric'})}
function renderReport(rows){
  const entries=(rows||[]).map(r=>({day:r.dimensionValues?.[0]?.value||'',users:Number(r.metricValues?.[0]?.value||0)})).filter(r=>/^\d{8}$/.test(r.day)).sort((a,b)=>a.day.localeCompare(b.day));
  const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
  const key=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('');
  const byDay=new Map(entries.map(e=>[e.day,e.users]));
  $('gaToday').textContent=String(byDay.get(key(today))??0);
  $('gaYesterday').textContent=String(byDay.get(key(yesterday))??0);
  const max=Math.max(1,...entries.map(e=>e.users));
  $('gaDaily').innerHTML=entries.map(e=>{
    const date=e.day.slice(6,8)+'. '+e.day.slice(4,6)+'. '+e.day.slice(0,4);
    const width=Math.max(0,Math.min(100,e.users/max*100));
    return '<div class="ga-day"><span>'+date+'</span><div class="ga-bar-track"><div class="ga-bar-fill" style="width:'+width+'%"></div></div><strong>'+e.users+'</strong></div>';
  }).join('')||'<p class="muted">Pro vybrané období nejsou dostupná data.</p>';
  $('gaReport').hidden=false;
}
async function fetchReport(property){
  showStatus('Načítám denní návštěvnost z Google Analytics…');
  const res=await fetch('https://analyticsdata.googleapis.com/v1beta/properties/'+encodeURIComponent(property)+':runReport',{
    method:'POST',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},
    body:JSON.stringify({dateRanges:[{startDate:'29daysAgo',endDate:'today'}],dimensions:[{name:'date'}],metrics:[{name:'activeUsers'}],orderBys:[{dimension:{dimensionName:'date'}}],limit:'40'})
  });
  const body=await res.json();
  if(!res.ok)throw Error(body.error?.message||'Google Analytics vrátil chybu '+res.status);
  renderReport(body.rows);
  showStatus('Aktualizováno: '+localDate(new Date())+'. Jde o aktivní uživatele GA4, nikoli přesný počet osob. Dnešní číslo je průběžné a může se zpožďovat.');
}
$('gaConnect')?.addEventListener('click',async()=>{
  try{
    if(document.body.classList.contains('guest'))throw Error('Nejdřív se přihlas jako administrátor RADARu.');
    const {client,property}=saveConfig();
    showStatus('Otevírám přihlášení Google…');
    if(!window.google?.accounts?.oauth2)await addScript('https://accounts.google.com/gsi/client');
    if(!window.google?.accounts?.oauth2)throw Error('Google přihlášení není dostupné.');
    tokenClient=window.google.accounts.oauth2.initTokenClient({
      client_id:client,scope:'https://www.googleapis.com/auth/analytics.readonly',
      callback:async response=>{
        if(response.error){showStatus('Google přihlášení: '+response.error);return}
        accessToken=response.access_token;
        try{await fetchReport(property)}catch(e){showStatus('Statistiky nelze načíst: '+e.message)}
      }
    });
    tokenClient.requestAccessToken({prompt:accessToken?'':'consent'});
  }catch(e){showStatus(e.message)}
});
$('gaRefresh')?.addEventListener('click',async()=>{
  try{
    if(document.body.classList.contains('guest'))throw Error('Vyžaduje přihlášení administrátora.');
    const {property}=saveConfig();
    if(!accessToken)throw Error('Nejdřív klikni na „Připojit Google Analytics“.');
    await fetchReport(property);
  }catch(e){showStatus(e.message)}
});
})();