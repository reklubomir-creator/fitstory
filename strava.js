/* RADAR: Strava CSV import. The file is processed locally; no upload to GitHub. */
(function(){
'use strict';
function parseCsv(text){
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++}else if(c==='"')quoted=false;else field+=c}
    else if(c==='"')quoted=true;
    else if(c===','){row.push(field);field=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v!==''))rows.push(row);row=[];field=''}
    else field+=c;
  }
  if(quoted)throw Error('CSV obsahuje neuzavřené uvozovky');
  if(field||row.length){row.push(field);rows.push(row)}
  return rows;
}
function n(v){if(v===undefined||v===null||String(v).trim()==='')return null;const x=Number(String(v).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null}
function day(v){const m=String(v||'').match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');const iso=String(v||'').match(/^(\d{4}-\d{2}-\d{2})/);return iso?iso[1]:null}
function parseActivities(text){
  const rows=parseCsv(text);if(rows.length<2)throw Error('CSV je prázdné');
  const header=rows.shift().map(x=>x.trim());
  function get(row,cs,en,occ=0){
    for(const name of [cs,en]){
      if(!name)continue;
      const hits=header.map((x,i)=>x===name?i:-1).filter(i=>i>=0);
      if(hits.length>occ)return row[hits[occ]]||'';
    }
    return '';
  }
  const required=[['ID aktivity','Activity ID'],['Datum aktivity','Activity Date'],['Název aktivity','Activity Name'],['Typ aktivity','Activity Type']];
  if(required.some(([cs,en])=>!header.includes(cs)&&!header.includes(en)))throw Error('Soubor nemá požadované sloupce Strava');
  const out=[];let skipped=0;let beforeDiet=0;
  for(const row of rows){
    const id=get(row,'ID aktivity','Activity ID').trim(),date=day(get(row,'Datum aktivity','Activity Date'));
    if(!id||!date){skipped++;continue}if(date<'2026-05-25'){beforeDiet++;continue}
    const distanceMeters=n(get(row,'Vzdálenost','Distance',1));
    const distanceKm=n(get(row,'Vzdálenost','Distance',0));
    const meters=distanceMeters!==null?distanceMeters:(distanceKm===null?null:distanceKm*1000);
    const elapsed=n(get(row,'Uplynulý čas','Elapsed Time',0));
    const moving=n(get(row,'Aktivní čas','Moving Time'));
    const hr=n(get(row,'Průměrná tepová frekvence','Average Heart Rate'));
    const maxHr=n(get(row,'Maximální tepová frekvence','Max Heart Rate',0));
    out.push({
      id,date,name:get(row,'Název aktivity','Activity Name')||'Aktivita',
      type:get(row,'Typ aktivity','Activity Type')||'Ostatní',
      description:get(row,'Popis aktivity','Activity Description')||'',
      elapsedSeconds:elapsed,movingSeconds:moving,
      distanceMeters:meters,
      avgHeartRate:hr,maxHeartRate:maxHr,
      calories:n(get(row,'Kalorie','Calories')),
      elevationMeters:n(get(row,'Nastoupaná výška','Elevation Gain')),
      sets:n(get(row,'Celkový počet sérií','Total Sets')),
      reps:n(get(row,'Celkový počet opakování','Total Reps')),
      source:'Strava CSV'
    });
  }
  return {out,skipped,beforeDiet};
}
function formatDuration(seconds){
  if(seconds===null||seconds===undefined)return '—';
  const m=Math.round(seconds/60);return m>=60?Math.floor(m/60)+' h '+String(m%60).padStart(2,'0')+' min':m+' min';
}
function activityKind(a){
  const raw=String(a.type||'').trim();
  const name=String(a.name||'');
  const description=String(a.description||'');
  const normalize=v=>String(v).toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const title=normalize(raw+' '+name);
  const full=normalize(name+' '+description);
  const treadmill=/\b(pas|pase|pasu|bezecky pas|treadmill|indoor run|indoor walk)\b/;
  const strength=/\b(posilov\w*|silov\w*|cink\w*|bench|drep\w*|leg press|deadlift|stroj\w*|seri\w*|squat|curl|row|press|extension|raise|pulldown|pullup|lat pulldown)\b/;
  // "Logged with Hevy" is a generic export footer, not evidence of strength training.
  const lines=description.split(/\r?\n/).map(x=>normalize(x.trim())).filter(Boolean);
  let treadmillSets=0,otherSets=0,treadmillMinutes=0,exercise='';
  for(const line of lines){
    const set=line.match(/^set\s+\d+\s*:/);
    if(set){
      if(treadmill.test(exercise)){
        treadmillSets++;
        const m=line.match(/(?:-|–)\s*(\d+(?:[.,]\d+)?)\s*(?:min|minutes?)\b/);
        if(m)treadmillMinutes+=Number(m[1].replace(',','.'));
      }else if(exercise)otherSets++;
    }else if(!/^logged with\b/.test(line)){
      exercise=line;
    }
  }
  if(treadmillSets&&!otherSets)return 'Trénink';
  if(otherSets&&!treadmillSets)return 'Posilování';
  if(treadmillSets&&otherSets){
    // Mixed session: classify by the dominant logged work, not by generic Strava type.
    return treadmillMinutes>0&&treadmillMinutes>otherSets*2?'Trénink':'Posilování';
  }
  if(treadmill.test(title)&&!strength.test(full))return 'Trénink';
  if(treadmill.test(full)&&!strength.test(full))return 'Trénink';
  if(strength.test(full)&&!treadmill.test(full))return 'Posilování';
  if(/^(treadmill|run|walk|virtualrun|indoor run|indoor walk)$/i.test(raw))return 'Trénink';
  if(/^(weight training|strength training|weighttraining|strengthtraining|posilovani|silovy trenink)$/i.test(raw))return 'Posilování';
  if(/^(workout|training|trenink|cviceni)$/i.test(raw))return 'Trénink';
  return raw||'Ostatní';
}
function activityDistanceMeters(a){
  const recorded=Number(a.distanceMeters);
  if(a.distanceMeters!=null&&Number.isFinite(recorded)&&recorded>0)return recorded;
  const description=String(a.description||'');
  // Hevy lists each treadmill interval as its own exercise block:
  // Treadmill\nSet 1: 0.4km - 5min\n\nTreadmill\nSet 1: 0.4km - 5min
  // Sum ALL treadmill sets rather than taking the largest single interval.
  let treadmillSetMeters=0;
  let treadmillSets=0;
  let inTreadmill=false;
  for(const rawLine of description.split(/\r?\n/)){
    const line=rawLine.trim();
    if(!line)continue;
    const set=line.match(/^Set\s+\d+\s*:\s*(\d+(?:[.,]\d+)?)\s*(km|kilomet(?:er|re)s?|kilometr(?:u|y|ů)?|m|metr(?:u|y|ů)?)\b/i);
    if(set){
      if(inTreadmill){
        const amount=Number(set[1].replace(',','.'));
        const unit=set[2].toLowerCase();
        const metres=unit==='m'||unit.startsWith('metr')?amount:amount*1000;
        if(Number.isFinite(metres)&&metres>0&&metres<=100000){treadmillSetMeters+=metres;treadmillSets++}
      }
    }else if(!/^Logged with\b/i.test(line)){
      // A non-set line is an exercise heading; only the Treadmill heading activates accumulation.
      inTreadmill=/^(treadmill|běžecký pás|bezecky pas)$/i.test(line);
    }
  }
  if(treadmillSets)return Math.round(treadmillSetMeters*100)/100;
  // Fallback for manually entered descriptions: explicit distance near treadmill wording.
  const text=(String(a.type||'')+' '+String(a.name||'')+' '+description).toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const treadmill='(?:bezeck(?:y|em|eho)?\\s+pas|na\\s+pasu|pasu|pase|treadmill)';
  const distance='(\\d{1,3}(?:[.,]\\d{1,3})?)\\s*(km|kilometr(?:u|y)?|m|metru|metry)\\b';
  const patterns=[new RegExp(treadmill+'[^\\n.;]{0,55}?'+distance,'gi'),new RegExp(distance+'[^\\n.;]{0,55}?'+treadmill,'gi')];
  const found=[];
  for(const pattern of patterns){
    let match;
    while((match=pattern.exec(text))){
      const amount=Number(match[1].replace(',','.'));
      const unit=match[2];
      const metres=unit==='m'||unit.startsWith('metr')?amount:amount*1000;
      if(Number.isFinite(metres)&&metres>0&&metres<=100000)found.push(metres);
    }
  }
  if(!found.length&&/treadmill|bezecky pas/.test(text)){
    const re=new RegExp(distance,'gi');let match;
    while((match=re.exec(text))){
      const amount=Number(match[1].replace(',','.'));
      const unit=match[2];
      const metres=unit==='m'||unit.startsWith('metr')?amount:amount*1000;
      if(Number.isFinite(metres)&&metres>0&&metres<=100000)found.push(metres);
    }
  }
  return found.length?Math.max(...found):(a.distanceMeters==null?null:recorded);
}
window.radarPublicExerciseList=function(){return (Array.isArray(data.activities)?data.activities:[]).filter(a=>typeof a.date==='string'&&a.date>='2026-05-25').map(a=>({date:a.date,type:activityKind(a),minutes:Math.max(0,Math.round((Number(a.movingSeconds??a.elapsedSeconds)||0)/60)),distanceKm:activityDistanceMeters(a)==null?null:Math.round(activityDistanceMeters(a)/10)/100})).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,100)};
window.radarPublicExerciseStats=function(){const a=(Array.isArray(data.activities)?data.activities:[]).filter(x=>typeof x.date==='string'&&x.date>='2026-05-25');return {count:a.length,distanceKm:Math.round(a.reduce((sum,x)=>sum+(activityDistanceMeters(x)||0),0)/100)/10,hours:Math.round(a.reduce((sum,x)=>sum+(Number(x.movingSeconds??x.elapsedSeconds)||0),0)/360)/10}};
function renderStrava(){
  const all=(Array.isArray(data.activities)?data.activities:[]).filter(x=>typeof x.date==='string'&&x.date>='2026-05-25');
  const yearSelect=document.getElementById('stravaYear'),typeSelect=document.getElementById('stravaType');
  if(!yearSelect||!typeSelect)return;
  const selectedYear=yearSelect.value,selectedType=typeSelect.value;
  const years=[...new Set(all.map(x=>x.date.slice(0,4)))].sort().reverse();
  yearSelect.innerHTML='<option value="all">Všechny roky</option>'+years.map(y=>'<option value="'+escapeHtml(y)+'">'+escapeHtml(y)+'</option>').join('');
  yearSelect.value=years.includes(selectedYear)?selectedYear:'all';
  const inYear=all.filter(x=>yearSelect.value==='all'||x.date.startsWith(yearSelect.value));
  const typesAvailable=[...new Set(inYear.map(activityKind))].sort((a,b)=>a.localeCompare(b,'cs'));
  typeSelect.innerHTML='<option value="all">Všechny aktivity</option>'+typesAvailable.map(t=>'<option value="'+escapeHtml(t)+'">'+escapeHtml(t)+'</option>').join('');
  typeSelect.value=typesAvailable.includes(selectedType)?selectedType:'all';
  const filtered=inYear.filter(x=>typeSelect.value==='all'||activityKind(x)===typeSelect.value);
  const today=new Date();const todayUtc=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate());const startUtc=Date.UTC(2026,4,25);const daysSinceStart=Math.max(0,Math.floor((todayUtc-startUtc)/86400000)+1);
  document.getElementById('stravaCount').textContent=filtered.length+' / '+daysSinceStart;
  document.getElementById('stravaDistance').textContent=fmt(filtered.reduce((sum,x)=>sum+(activityDistanceMeters(x)||0),0)/1000)+' km';
  document.getElementById('stravaHours').textContent=fmt(filtered.reduce((sum,x)=>sum+(Number(x.movingSeconds??x.elapsedSeconds)||0),0)/3600)+' h';
  const types={};for(const a of filtered)types[activityKind(a)]=(types[activityKind(a)]||0)+1;
  document.getElementById('stravaTypes').textContent=String(Object.keys(types).length);
  document.getElementById('stravaBreakdown').textContent=Object.entries(types).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+': '+v).join(' · ');
  document.getElementById('stravaRows').innerHTML=filtered.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(a=>{
    const id=escapeHtml(a.id);
    const stats=[
      ['Délka',formatDuration(a.movingSeconds??a.elapsedSeconds)],
      ['Vzdálenost',activityDistanceMeters(a)==null?null:fmt(activityDistanceMeters(a)/1000,2)+' km'],
      ['Průměrný tep',a.avgHeartRate==null?null:fmt(a.avgHeartRate,0)+' tepů/min'],
      ['Maximální tep',a.maxHeartRate==null?null:fmt(a.maxHeartRate,0)+' tepů/min'],
      ['Kalorie',a.calories==null?null:fmt(a.calories,0)+' kcal'],
      ['Převýšení',a.elevationMeters==null?null:fmt(a.elevationMeters,0)+' m'],
      ['Série',a.sets==null?null:fmt(a.sets,0)],
      ['Opakování',a.reps==null?null:fmt(a.reps,0)]
    ].filter(x=>x[1]!==null).map(([k,v])=>'<span class="pill">'+escapeHtml(k)+': '+escapeHtml(v)+'</span>').join('');
    const description=String(a.description||'').trim();
    const details='<div class="activity-detail-inner">'+stats+
      (description?'<pre>'+escapeHtml(description)+'</pre>':'<p class="muted">K této aktivitě není v exportu Stravy uveden podrobný popis.</p>')+'</div>';
    return '<tr class="activity-row" data-activity-toggle="'+id+'">'+
      '<td>'+escapeHtml(a.date)+'</td>'+
      '<td><button type="button" class="activity-toggle" data-activity-button="'+id+'" aria-expanded="false">▸ '+escapeHtml(a.name)+'</button></td>'+
      '<td>'+escapeHtml(activityKind(a))+'</td>'+
      '<td>'+formatDuration(a.movingSeconds??a.elapsedSeconds)+'</td>'+
      '<td>'+(activityDistanceMeters(a)==null?'—':fmt(activityDistanceMeters(a)/1000,2))+'</td>'+
      '<td>'+(a.avgHeartRate==null?'—':fmt(a.avgHeartRate,0))+'</td>'+
      '<td>'+(a.calories==null?'—':fmt(a.calories,0))+'</td>'+
      '<td><button class="delete" data-strava-del="'+id+'">Smazat</button></td></tr>'+
      '<tr class="activity-detail" data-detail-for="'+id+'" style="display:none"><td colspan="8">'+details+'</td></tr>';
  }).join('');
}
document.getElementById('stravaYear').addEventListener('change',renderStrava);
document.getElementById('stravaType').addEventListener('change',renderStrava);
document.getElementById('stravaRows').addEventListener('click',e=>{
  if(e.target.closest('[data-strava-del]'))return;
  const row=e.target.closest('[data-activity-toggle]');if(!row)return;
  const id=row.dataset.activityToggle;
  const detail=[...document.querySelectorAll('[data-detail-for]')].find(el=>el.dataset.detailFor===id);
  const button=row.querySelector('[data-activity-button]');
  if(!detail||!button)return;
  const expanded=detail.style.display==='none';
  detail.style.display=expanded?'table-row':'none';
  button.setAttribute('aria-expanded',String(expanded));
  button.textContent=(expanded?'▾ ':'▸ ')+button.textContent.slice(2);
});
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.page==='strava')renderStrava()}));
document.getElementById('stravaLoad').addEventListener('click',async()=>{
  const file=document.getElementById('stravaFile').files[0],status=document.getElementById('stravaStatus');
  if(!file){status.textContent='Vyber nejdříve CSV soubor.';return}
  try{
    const parsed=parseActivities(await file.text());
    const existing=new Set(data.activities.map(x=>String(x.id)));
    const seen=new Set();const incoming=parsed.out.filter(x=>{if(seen.has(x.id))return false;seen.add(x.id);return !existing.has(x.id)});
    if(!confirm('Načteno '+parsed.out.length+' aktivit. Nových: '+incoming.length+'. Importovat?'))return;
    data.activities.push(...incoming);
    try{save()}catch(e){data.activities.splice(data.activities.length-incoming.length,incoming.length);throw Error('Úložiště prohlížeče je plné. Exportuj zálohu a zkus import znovu.')}
    renderStrava();
    status.textContent='Hotovo: přidáno '+incoming.length+' aktivit od 25. 5. 2026, přeskočeno '+(parsed.out.length-incoming.length)+' již uložených nebo opakovaných, '+parsed.beforeDiet+' starších aktivit'+(parsed.skipped?', neplatných řádků: '+parsed.skipped:'')+'.';
  }catch(e){status.textContent='Import se nezdařil: '+e.message}
});
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-strava-del]');if(!b)return;
  if(!confirm('Smazat tuto aktivitu ze Stravy z RADARu?'))return;
  data.activities=data.activities.filter(a=>String(a.id)!==b.dataset.stravaDel);
  save();renderStrava();
});
document.addEventListener('radar:data-changed',renderStrava);
renderStrava();
})();