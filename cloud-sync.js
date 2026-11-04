/* RADAR cloud sync: private Firebase Authentication + Realtime Database.
   No personal data is stored in GitHub. Requires user-owned Firebase configuration
   and Realtime Database rules restricting users/$uid to auth.uid === $uid. */
const status=document.getElementById('cloudStatus');
const login=document.getElementById('cloudLogin');
const logged=document.getElementById('cloudLogged');
const btn=id=>document.getElementById(id);
const setStatus=(message)=>{status.textContent=message};
const config=window.RADAR_FIREBASE_CONFIG;
if(!config||!config.apiKey||!config.databaseURL||!config.projectId){
  login.hidden=true;
  document.body.classList.remove('auth-pending');
  setStatus('Cloud zatím není nastavený. Je potřeba připojit vlastní projekt Firebase; místní data zůstávají beze změny.');
}else{
  try{
    const {initializeApp}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const {getAuth,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    const {getDatabase,ref,get,onValue,set,serverTimestamp}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js');
    const app=initializeApp(config);
    const auth=getAuth(app),db=getDatabase(app);
    const OWNER_UID='M8VZmCpDslf5lJiziK5fHAsXnFg1';
    const publicRef=ref(db,'public/radar');
    let publicSnapshot=null;
    onValue(publicRef,snap=>{publicSnapshot=snap.val();window.radarPublicRender?.(publicSnapshot)},err=>{if(document.body.classList.contains('guest'))document.getElementById('progressText').textContent='Veřejná data nejsou dostupná: '+err.message});
    async function publishPublic(){
      if(!user||user.uid!==OWNER_UID||!active)return;
      const weights=(Array.isArray(data.weights)?data.weights:[]).filter(w=>/^\d{4}-\d{2}-\d{2}$/.test(w.date)&&Number.isFinite(Number(w.kg))).map(w=>({date:w.date,kg:Number(w.kg)})).sort((a,b)=>a.date.localeCompare(b.date));
      const activity=window.radarPublicExerciseStats?.()||{count:0,distanceKm:0,hours:0};
      const exerciseList=window.radarPublicExerciseList?.()||[];
      await set(publicRef,{...(publicSnapshot||{}),weights,activity,exerciseList,updatedAt:new Date().toISOString()});
    }
    let user=null,active=false,unsubscribe=null,remoteExists=false,remoteVersion=null;
    let pending=false,writing=false,writeTimer=null;
    const fingerprint=value=>{let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}return (hash>>>0).toString(16)};
    const localText=()=>JSON.stringify(data);
    const currentHash=()=>fingerprint(localText());
    const linkedKey='radar-cloud-linked-uid',hashKey='radar-cloud-last-hash';
    const dataRef=()=>ref(db,'users/'+user.uid+'/radar');
    function applyRemote(remote){
      if(!remote||!remote.data||typeof remote.data!=='object')return;
      const incoming=remote.data;
      if(!Array.isArray(incoming.weights)||!Array.isArray(incoming.activities))throw Error('Cloudová data nemají správný formát.');
      data=incoming;
      for(const field of ['weights','workouts','foods','activities','milestones','body','labs'])if(!Array.isArray(data[field]))data[field]=[];
      data.activities=data.activities.filter(a=>typeof a.date==='string'&&a.date>='2026-05-25');
      localStorage.setItem('radar-v1',JSON.stringify(data));
      localStorage.setItem(hashKey,currentHash());
      render();
      document.dispatchEvent(new Event('radar:data-changed'));
    }
    function subscribe(){
      if(unsubscribe)unsubscribe();
      unsubscribe=onValue(dataRef(),snap=>{
        const remote=snap.val();
        remoteExists=!!remote;
        if(!remote||!remote.data)return;
        remoteVersion=remote.updatedAt||null;
        if(pending||writing)return;
        try{
          if(fingerprint(JSON.stringify(remote.data))!==currentHash()){
            applyRemote(remote);
            setStatus('Synchronizováno – změny z dalšího zařízení byly načteny.');
          }
          publishPublic().catch(err=>setStatus('Soukromá data jsou načtena, ale veřejný přehled se neaktualizoval: '+err.message));
        }catch(err){setStatus('Chyba načítání: '+err.message)}
      },err=>setStatus('Cloud není dostupný: '+err.message));
    }
    function connect(){
      active=true;pending=false;
      localStorage.setItem(linkedKey,user.uid);
      localStorage.setItem(hashKey,currentHash());
      subscribe();
      // Public projection is published only after the authoritative private snapshot has loaded.
      setStatus('Synchronizace je aktivní. Změny se automaticky ukládají do cloudu.');
    }
    async function upload(){
      if(!user)return;
      if(remoteExists&&!confirm('Přepsat cloudová data daty z tohoto zařízení? Původní cloudový stav bude nahrazen.'))return;
      try{
        setStatus('Nahrávám data do cloudu…');
        writing=true;
        await set(dataRef(),{data:JSON.parse(localText()),updatedAt:serverTimestamp()});
        writing=false;remoteExists=true;connect();
        await publishPublic().catch(err=>setStatus('Soukromá data nahrána, ale zveřejnění selhalo: '+err.message));
      }catch(err){writing=false;setStatus('Nahrání selhalo: '+err.message)}
    }
    async function download(){
      if(!user)return;
      if(!confirm('Nahradit data v tomto prohlížeči cloudovou verzí? Nejdřív si případně stáhni JSON zálohu.'))return;
      try{
        const snap=await get(dataRef());
        if(!snap.exists()||!snap.val().data){setStatus('V cloudu zatím žádná data nejsou. Nejdřív je nahraj z původního zařízení.');return}
        applyRemote(snap.val());connect();
      }catch(err){setStatus('Stažení selhalo: '+err.message)}
    }
    async function flush(){
      if(!user||!active||!pending||writing)return;
      writing=true;
      try{
        const payload=JSON.parse(localText());
        const sentHash=fingerprint(JSON.stringify(payload));
        await set(dataRef(),{data:payload,updatedAt:serverTimestamp()});
        localStorage.setItem(hashKey,sentHash);
        pending=currentHash()!==sentHash;
        setStatus(pending?'Během ukládání přibyly změny; dokončuji synchronizaci…':'Všechny změny jsou synchronizované.');
        if(!pending)await publishPublic().catch(err=>setStatus('Soukromá data uložena, ale veřejný přehled se neaktualizoval: '+err.message));
      }catch(err){setStatus('Změny jsou uložené místně, cloud zatím ne: '+err.message)}
      finally{writing=false;if(pending){clearTimeout(writeTimer);writeTimer=setTimeout(flush,2000)}}
    }
    window.radarCloudChanged=()=>{
      if(!active||!user)return;
      pending=true;setStatus('Ukládám změny…');
      clearTimeout(writeTimer);writeTimer=setTimeout(flush,800);
    };
    window.radarLoginReady=true;
    const signInButton=btn('cloudSignIn');
    signInButton.onclick=async()=>{
      const email=btn('cloudEmail').value.trim(),password=btn('cloudPassword').value;
      if(!email||!password){setStatus('Vyplň e-mail i heslo.');return}
      signInButton.disabled=true;
      setStatus('Přihlašuji k Firebase…');
      try{
        await signInWithEmailAndPassword(auth,email,password);
        setStatus('Přihlášení ověřeno. Načítám administraci…');
      }catch(err){
        setStatus('Přihlášení selhalo ('+(err.code||'neznámá chyba')+'): '+err.message);
      }finally{signInButton.disabled=false}
    };
    for(const field of ['cloudEmail','cloudPassword']){
      btn(field).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();signInButton.click()}});
    }

    const stravaTestButton=btn('stravaAdminTest');
    const stravaTestStatus=btn('stravaAdminTestStatus');
    const stravaTestEndpoint='https://europe-west1-radarfit-25e17.cloudfunctions.net/stravaAdminCheck';
    let stravaTestRequest=0;
    stravaTestButton.onclick=async()=>{
      const currentUser=auth.currentUser;
      if(!currentUser||currentUser.uid!==OWNER_UID){
        stravaTestStatus.textContent='Nejdřív se přihlas jako administrátor.';
        return;
      }
      const requestId=++stravaTestRequest;
      stravaTestButton.disabled=true;
      stravaTestStatus.textContent='Ověřuji přístup k serveru…';
      try{
        const idToken=await currentUser.getIdToken();
        if(requestId!==stravaTestRequest||auth.currentUser?.uid!==OWNER_UID)return;
        const response=await fetch(stravaTestEndpoint,{
          method:'POST',
          headers:{'Authorization':'Bearer '+idToken,'Content-Type':'application/json'},
          body:'{}',
          cache:'no-store'
        });
        const result=await response.json();
        if(requestId!==stravaTestRequest||auth.currentUser?.uid!==OWNER_UID)return;
        if(response.ok&&result.success===true&&result.stravaClientId==='293370'){
          stravaTestStatus.textContent='Přístup administrátora ověřen (HTTP '+response.status+'). Strava OAuth zatím není propojené.';
        }else{
          stravaTestStatus.textContent='Ověření neprošlo (HTTP '+response.status+'): '+String(result.error||'Neznámá odpověď serveru');
        }
      }catch(err){
        if(requestId===stravaTestRequest&&auth.currentUser?.uid===OWNER_UID)stravaTestStatus.textContent='Server není dostupný: '+err.message;
      }finally{
        if(requestId===stravaTestRequest)stravaTestButton.disabled=auth.currentUser?.uid!==OWNER_UID;
      }
    };
    const stravaConnectButton=btn('stravaConnectButton');
    const stravaConnectStatus=btn('stravaConnectStatus');
    const stravaConnectEndpoint='https://europe-west1-radarfit-25e17.cloudfunctions.net/stravaConnect';
    let stravaConnectRequest=0;
    stravaConnectButton.onclick=async()=>{
      const currentUser=auth.currentUser;
      if(!currentUser||currentUser.uid!==OWNER_UID){
        stravaConnectStatus.textContent='Nejdřív se přihlas jako administrátor.';
        return;
      }
      const requestId=++stravaConnectRequest;
      stravaConnectButton.disabled=true;
      stravaConnectStatus.textContent='Připravuji bezpečné přesměrování na Stravu…';
      try{
        const idToken=await currentUser.getIdToken();
        if(requestId!==stravaConnectRequest||auth.currentUser?.uid!==OWNER_UID)return;
        const response=await fetch(stravaConnectEndpoint,{
          method:'POST',
          headers:{'Authorization':'Bearer '+idToken,'Content-Type':'application/json'},
          body:'{}',
          cache:'no-store'
        });
        const result=await response.json();
        if(requestId!==stravaConnectRequest||auth.currentUser?.uid!==OWNER_UID)return;
        if(!response.ok)throw Error('HTTP '+response.status+': '+String(result.error||'Server odmítl požadavek'));
        const url=new URL(result.url);
        if(url.origin!=='https://www.strava.com'||url.pathname!=='/oauth/authorize'||url.searchParams.get('client_id')!=='293370'){
          throw Error('Server vrátil neočekávanou adresu autorizace.');
        }
        stravaConnectStatus.textContent='Přesměrovávám na Stravu…';
        window.location.assign(url.href);
      }catch(err){
        if(requestId===stravaConnectRequest&&auth.currentUser?.uid===OWNER_UID)stravaConnectStatus.textContent='Propojení se nepodařilo zahájit: '+err.message;
      }finally{
        if(requestId===stravaConnectRequest)stravaConnectButton.disabled=auth.currentUser?.uid!==OWNER_UID;
      }
    };
    const stravaRefreshList=btn('stravaRefreshList');
    const stravaListStatus=btn('stravaListStatus');
    const stravaActivityList=btn('stravaActivityList');
    let stravaListRequest=0;
    let stravaPublishRequested=true;
    let stravaPage=0;
    function parseHevyDescription(raw){
      const clean=String(raw||'').replace(/&#x20;|&#32;|&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\r/g,'');
      const exercises=[];
      let current=null;
      for(const line of clean.split('\n')){
        const value=line.trim();
        if(!value||/^Logged with hevyapp\.com/i.test(value))continue;
        if(/^Set\s*\d+\s*:/i.test(value)){
          if(current)current.sets.push(value);
        }else if(!/^https?:\/\//i.test(value)){
          current={name:value,sets:[]};
          exercises.push(current);
        }
      }
      return {clean,exercises:exercises.filter(e=>e.sets.length)};
    }
    const exerciseCzech={
      'Warm Up':'Rozcvičení','Shoulder Press (Dumbbell)':'Tlaky na ramena s jednoručkami',
      'Chest Fly (Machine)':'Rozpažování na stroji','Lat Pulldown (Cable)':'Stahování horní kladky',
      'Seated Cable Row - V Grip (Cable)':'Přítahy spodní kladky vsedě s V úchopem',
      'Bicep Curl (Cable)':'Bicepsový zdvih na kladce','Standing Calf Raise':'Výpony na lýtka ve stoje',
      'Shrug (Dumbbell)':'Krčení ramen s jednoručkami','Treadmill':'Běžecký pás',
      'Romanian Deadlift (Dumbbell)':'Rumunský mrtvý tah s jednoručkami',
      'Incline Bench Press (Dumbbell)':'Tlaky s jednoručkami na šikmé lavici',
      'Lateral Raise (Dumbbell)':'Upažování s jednoručkami',
      'Dumbbell Row':'Přítahy jednoručky','Triceps Extension (Cable)':'Tricepsové extenze na kladce'
    };
    const exerciseLabel=name=>name+(exerciseCzech[name]?' ('+exerciseCzech[name]+')':'');
    function renderExerciseComparison(activities){
      const select=document.getElementById('exerciseCompareA');
      const output=document.getElementById('exerciseCompareResult');
      if(!select||!output)return;
      const records=new Map();
      for(const a of activities){
        // Deload is excluded only when explicitly labeled, not inferred from lighter loads.
        if(/\bdeload\b|odlehčovac[íi]|odlehčen[ýy]/i.test(String(a.name||'')+' '+String(a.description||'')))continue;
        const day=String(a.startDate||'').slice(0,10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
        // Repeated Hevy exercise blocks in one activity belong to one session.
        const sessionExercises=new Map();
        for(const exercise of parseHevyDescription(a.description).exercises){
          const sets=exercise.sets.map(set=>{
            const m=set.match(/:\s*([\d.,]+)\s*kg\s*x\s*(\d+)/i);
            return m?{kg:Number(m[1].replace(',','.')),reps:Number(m[2])}:null;
          }).filter(x=>x&&Number.isFinite(x.kg)&&Number.isFinite(x.reps));
          if(!sets.length)continue;
          if(!sessionExercises.has(exercise.name))sessionExercises.set(exercise.name,[]);
          sessionExercises.get(exercise.name).push(...sets);
        }
        for(const [name,sets] of sessionExercises){
          if(!records.has(name))records.set(name,[]);
          records.get(name).push({day,id:String(a.id||''),sets,max:Math.max(...sets.map(x=>x.kg)),volume:sets.reduce((sum,x)=>sum+x.kg*x.reps,0)});
        }
      }
      const names=[...records.keys()].sort((a,b)=>a.localeCompare(b,'cs'));
      const old=select.value;
      select.replaceChildren();
      for(const name of names){
        const option=document.createElement('option');
        option.value=name;option.textContent=exerciseLabel(name);select.appendChild(option);
      }
      if(names.includes(old))select.value=old;
      const fmt=n=>n.toLocaleString('cs-CZ',{maximumFractionDigits:1});
      const fmtDate=iso=>/^\d{4}-\d{2}-\d{2}$/.test(iso)?iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(0,4):iso;
      const draw=()=>{
        output.replaceChildren();
        const items=(records.get(select.value)||[]).sort((a,b)=>a.day.localeCompare(b.day)||a.id.localeCompare(b.id));
        if(!items.length){output.textContent='Pro tento cvik nejsou dostupné záznamy s váhou a opakováními.';return;}
        if(items.length<2){output.textContent='Zatím je dostupný jen jeden trénink tohoto cviku ('+fmtDate(items[0].day)+'). Pro porovnání jsou potřeba alespoň dva.';return;}
        const first=items[0],last=items[items.length-1];
        const table=document.createElement('table');table.style.width='100%';table.classList.add('exercise-progress-table');
        for(const values of [
          ['Ukazatel','První: '+fmtDate(first.day),'Poslední: '+fmtDate(last.day)],
          ['Nejvyšší pracovní váha',fmt(first.max)+' kg',fmt(last.max)+' kg'],
          ['Série',String(first.sets.length),String(last.sets.length)],
          ['Objem (kg × opakování)',fmt(first.volume)+' kg',fmt(last.volume)+' kg'],
          ['Série a opakování',first.sets.map(x=>fmt(x.kg)+' kg × '+x.reps).join('; '),last.sets.map(x=>fmt(x.kg)+' kg × '+x.reps).join('; ')]
        ]){
          const tr=document.createElement('tr');
          for(let j=0;j<values.length;j++){const td=document.createElement('td');td.textContent=j===0?values[j]:(values[0]==='Ukazatel'?values[j]:(j===1?'První ('+fmtDate(first.day)+'): ':'Poslední ('+fmtDate(last.day)+'): ')+values[j]);td.style.padding='8px';td.style.verticalAlign='top';tr.appendChild(td);}
          table.appendChild(tr);
        }
        output.appendChild(table);
        const chartTitle=document.createElement('h3');
        chartTitle.textContent='Vývoj nejvyšší pracovní váhy';
        chartTitle.style.margin='18px 0 8px';
        output.appendChild(chartTitle);
        const svgNS='http://www.w3.org/2000/svg';
        const svg=document.createElementNS(svgNS,'svg');
        svg.setAttribute('viewBox','0 0 700 260');
        svg.setAttribute('role','img');
        svg.setAttribute('aria-label','Vývoj pracovní váhy v kilogram ech podle data tréninku'.replace('kilogram ech','kilogramech'));
        svg.style.cssText='display:block;width:100%;height:auto;max-width:760px';
        const margin={left:56,right:24,top:24,bottom:44};
        const chartW=700-margin.left-margin.right,chartH=260-margin.top-margin.bottom;
        const values=items.map(x=>x.max);
        const low=Math.max(0,Math.floor((Math.min(...values)-5)/5)*5);
        const high=Math.ceil((Math.max(...values)+5)/5)*5;
        const range=Math.max(1,high-low);
        const timestamps=items.map(x=>Date.parse(x.day+'T12:00:00Z'));
        const minTime=Math.min(...timestamps),maxTime=Math.max(...timestamps);
        const x=i=>margin.left+(maxTime===minTime?(items.length===1?chartW/2:i*chartW/Math.max(1,items.length-1)):(timestamps[i]-minTime)/(maxTime-minTime)*chartW);
        const y=v=>margin.top+(high-v)/range*chartH;
        const add=(tag,attrs,textValue)=>{
          const node=document.createElementNS(svgNS,tag);
          for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));
          if(textValue!==undefined)node.textContent=String(textValue);
          svg.appendChild(node);return node;
        };
        // Visible axes and readable ticks, matching the public progress chart.
        add('line',{x1:margin.left,y1:margin.top,x2:margin.left,y2:260-margin.bottom,stroke:'currentColor','stroke-opacity':'.6'});
        add('line',{x1:margin.left,y1:260-margin.bottom,x2:700-margin.right,y2:260-margin.bottom,stroke:'currentColor','stroke-opacity':'.6'});
        for(let tick=0;tick<=4;tick++){
          const value=low+range*tick/4,py=y(value);
          add('line',{x1:margin.left,y1:py,x2:700-margin.right,y2:py,stroke:'currentColor','stroke-opacity':'.16'});
          add('text',{x:margin.left-9,y:py+4,'text-anchor':'end',fill:'currentColor','font-size':12},fmt(value));
          const fraction=tick/4;
          const date=new Date(minTime+(maxTime-minTime)*fraction).toISOString().slice(0,10);
          add('text',{x:margin.left+chartW*fraction,y:237,'text-anchor':'middle',fill:'currentColor','font-size':11},fmtDate(date));
        }
        add('text',{x:14,y:16,fill:'currentColor','font-size':12},'kg');
        add('text',{x:margin.left+chartW/2,y:255,'text-anchor':'middle',fill:'currentColor','font-size':12},'Datum tréninku');
        add('polyline',{points:items.map((e,i)=>x(i).toFixed(1)+','+y(e.max).toFixed(1)).join(' '),fill:'none',stroke:'#b4ed63','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'});
        for(let i=0;i<items.length;i++){
          const point=add('circle',{cx:x(i),cy:y(items[i].max),r:4,fill:'#b4ed63',stroke:'#17231b','stroke-width':1});
          const tooltip=document.createElementNS(svgNS,'title');
          tooltip.textContent=fmtDate(items[i].day)+': '+fmt(items[i].max)+' kg; '+items[i].sets.length+' sérií';
          point.appendChild(tooltip);
        }
        const tip=document.createElement('div');
        tip.style.cssText='display:none;position:absolute;pointer-events:none;background:#17231b;color:white;border:1px solid #b4ed63;border-radius:8px;padding:6px 10px;font-size:13px;white-space:nowrap;z-index:2';
        const wrap=document.createElement('div');wrap.style.cssText='position:relative;max-width:760px';
        wrap.appendChild(svg);wrap.appendChild(tip);
        svg.querySelectorAll('circle').forEach((point,i)=>{
          const show=()=>{
            tip.textContent=fmtDate(items[i].day)+' · '+fmt(items[i].max)+' kg';
            tip.style.left=Math.min(80,Math.max(3,x(i)/700*100))+'%';
            tip.style.top=Math.max(0,y(items[i].max)/260*100-16)+'%';
            tip.style.display='block';
          };
          point.setAttribute('tabindex','0');
          point.setAttribute('role','button');
          point.setAttribute('aria-label',fmtDate(items[i].day)+': '+fmt(items[i].max)+' kg');
          point.style.cursor='pointer';
          point.addEventListener('mouseenter',show);
          point.addEventListener('focus',show);
          point.addEventListener('mouseleave',()=>tip.style.display='none');
          point.addEventListener('blur',()=>tip.style.display='none');
        });
        output.appendChild(wrap);
        const chartNote=document.createElement('p');chartNote.className='muted tiny';
        chartNote.textContent='Každý bod představuje jeden zaznamenaný trénink. Osa Y: nejvyšší pracovní váha (kg).';
        output.appendChild(chartNote);
        const note=document.createElement('p');note.className='muted tiny';
        note.textContent='Rozdíl nejvyšší váhy: '+(last.max-first.max>=0?'+':'')+fmt(last.max-first.max)+' kg. Deload se vynechává jen při výslovném označení v názvu nebo popisu aktivity.';
        output.appendChild(note);
      };
      select.onchange=draw;draw();
    }
    function publicStravaActivity(a){
      const date=String(a.startDate||'').slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'2026-05-25')return null;
      const parsed=parseHevyDescription(a.description);
      const times=a.heartRateStream?.time,bpm=a.heartRateStream?.bpm;
      const points=[];
      if(Array.isArray(times)&&Array.isArray(bpm)){
        const count=Math.min(times.length,bpm.length);
        const stride=Math.max(1,Math.ceil(count/120));
        for(let i=0;i<count;i+=stride){
          const t=Number(times[i]),v=Number(bpm[i]);
          if(Number.isFinite(t)&&Number.isFinite(v)&&t>=0&&v>=30&&v<=240)points.push([t,v]);
        }
        if(count>1&&(count-1)%stride!==0){
          const t=Number(times[count-1]),v=Number(bpm[count-1]);
          if(Number.isFinite(t)&&Number.isFinite(v)&&t>=0&&v>=30&&v<=240)points.push([t,v]);
        }
      }
      const rate=points.map(x=>x[1]);
      const average=a.averageHeartrate==null?NaN:Number(a.averageHeartrate),maximum=a.maxHeartrate==null?NaN:Number(a.maxHeartrate);
      const heartRate=points.length>1?{
        points,min:Math.min(...rate),
        avg:Number.isFinite(average)?average:rate.reduce((x,y)=>x+y,0)/rate.length,
        max:Number.isFinite(maximum)?maximum:Math.max(...rate)
      }:null;
      return {
        id:'strava-'+String(a.id||date+'-'+String(a.name||'')),
        date,name:String(a.name||a.sportType||a.type||'Aktivita').slice(0,140),
        type:String(a.sportType||a.type||'Aktivita').slice(0,80),
        minutes:Math.round(Math.max(0,Number(a.movingTime)||0)/60),
        distanceKm:Number(a.distance)>0?Number(a.distance)/1000:null,
        avgHeartRate:Number.isFinite(average)?average:null,
        maxHeartRate:Number.isFinite(maximum)?maximum:null,
        description:parsed.exercises.map(e=>exerciseLabel(e.name)+'\n'+e.sets.join('\n')).join('\n\n').slice(0,12000),
        heartRate
      };
    }
    async function publishStravaExercises(activities){
      if(auth.currentUser?.uid!==OWNER_UID)return;
      const list=activities.map(publicStravaActivity).filter(Boolean);
      if(!list.length)return;
      const weightsSnapshot=await get(ref(db,'public/radar/weights'));
      if(!Array.isArray(weightsSnapshot.val()))throw Error('Veřejný přehled nemá platná data hmotnosti; publikace Stravy byla bezpečně zastavena.');
      // Write only the Strava branch: never rewrite weights or legacy workouts.
      // No route geometry, GPS coordinates or unfiltered private descriptions.
      await set(ref(db,'public/radar/stravaExerciseList'),list);
      await set(ref(db,'public/radar/stravaExerciseUpdatedAt'),new Date().toISOString());
    }
    async function loadStravaActivities(){
      const requestId=++stravaListRequest;
      const uid=auth.currentUser?.uid;
      if(uid!==OWNER_UID)return;
      stravaRefreshList.disabled=true;
      stravaListStatus.textContent='Načítám uložené aktivity…';
      try{
        const snapshot=await get(ref(db,'users/'+OWNER_UID+'/stravaActivities'));
        if(requestId!==stravaListRequest||auth.currentUser?.uid!==OWNER_UID)return;
        const values=snapshot.val()||{};
        const activities=Object.values(values).filter(x=>x&&typeof x==='object')
          .sort((a,b)=>String(b.startDate||'').localeCompare(String(a.startDate||'')));
        window.radarApiActivities=activities;
        document.dispatchEvent(new Event('radar:data-changed'));
        renderExerciseComparison(activities);
        // Avoid blocking login and list rendering with public database writes.
        if(stravaPublishRequested){
          stravaPublishRequested=false;
          void publishStravaExercises(activities).then(()=>{
            stravaListStatus.textContent+=' · Aktivity Stravy zveřejněny v Cvičení.';
          }).catch(publicError=>{
            console.warn('Zveřejnění souhrnu Stravy se nezdařilo:',publicError);
            stravaListStatus.textContent+=' · Zveřejnění selhalo: '+publicError.message;
          });
        }
        stravaActivityList.replaceChildren();
        const pageSize=10;
        const totalPages=Math.max(1,Math.ceil(activities.length/pageSize));
        stravaPage=Math.min(stravaPage,totalPages-1);
        stravaListStatus.textContent=activities.length?
          'Uloženo '+activities.length+' aktivit · stránka '+(stravaPage+1)+' z '+totalPages+'.':
          'Zatím nejsou uložené žádné aktivity.';
        const dateFormat=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'medium',timeStyle:'short'});
        for(const a of activities.slice(stravaPage*pageSize,(stravaPage+1)*pageSize)){
          const item=document.createElement('div');
          item.style.cssText='padding:10px 0;border-bottom:1px solid var(--line,#ddd)';
          const heading=document.createElement('strong');
          let date='Datum neuvedeno';
          const parsed=new Date(a.startDate);
          if(Number.isFinite(parsed.getTime()))date=dateFormat.format(parsed);
          heading.textContent=date+' · '+String(a.name||a.sportType||a.type||'Aktivita');
          item.appendChild(heading);
          const detail=document.createElement('div');
          detail.className='muted tiny';
          const parts=[String(a.sportType||a.type||'Neurčeno')];
          if(Number(a.movingTime)>0)parts.push('Čas '+Math.round(Number(a.movingTime)/60)+' min');
          if(Number(a.distance)>0)parts.push('Vzdálenost '+(Number(a.distance)/1000).toLocaleString('cs-CZ',{maximumFractionDigits:2})+' km');
          if(Number.isFinite(a.averageHeartrate))parts.push('Průměrný tep '+a.averageHeartrate+' bpm');
          if(Number.isFinite(a.maxHeartrate))parts.push('Max. tep '+a.maxHeartrate+' bpm');
          if(Array.isArray(a.heartRateStream?.bpm))parts.push('Tepová křivka: '+a.heartRateStream.bpm.length+' bodů');
          detail.textContent=parts.join(' · ');
          item.appendChild(detail);
          const panel=document.createElement('div');
          panel.hidden=true;
          panel.style.cssText='padding:12px 0';
          const description=document.createElement('p');
          description.style.whiteSpace='pre-wrap';
          const hevy=parseHevyDescription(a.description);
          description.textContent=hevy.clean||'Popis aktivity není dostupný.';
          if(hevy.exercises.length){
            const heading=document.createElement('strong');
            heading.textContent='Cviky a série z Hevy ('+hevy.exercises.length+' položek)';
            panel.appendChild(heading);
            const table=document.createElement('table');
            table.style.cssText='width:100%;margin:8px 0 14px;border-collapse:collapse';table.classList.add('hevy-exercises-table');
            const body=document.createElement('tbody');
            for(const exercise of hevy.exercises){
              const row=document.createElement('tr');
              const name=document.createElement('td');
              name.textContent=exerciseLabel(exercise.name);
              name.style.cssText='vertical-align:top;padding:7px 10px 7px 0;font-weight:600';
              const sets=document.createElement('td');
              sets.style.cssText='padding:7px 0;white-space:pre-line';
              sets.textContent=exercise.sets.join('\n');
              row.append(name,sets);body.appendChild(row);
            }
            table.appendChild(body);panel.appendChild(table);
            description.hidden=true;
          }
          panel.appendChild(description);
          const times=a.heartRateStream?.time,bpm=a.heartRateStream?.bpm;
          if(Array.isArray(times)&&Array.isArray(bpm)&&times.length&&bpm.length){
            const n=Math.min(times.length,bpm.length);
            const pairs=[];
            for(let i=0;i<n;i++)if(Number.isFinite(Number(times[i]))&&Number.isFinite(Number(bpm[i])))pairs.push([Number(times[i]),Number(bpm[i])]);
            if(pairs.length>1){
              const title=document.createElement('strong');
              title.textContent='Tepová křivka';
              panel.appendChild(title);
              const svgNS='http://www.w3.org/2000/svg';
              const svg=document.createElementNS(svgNS,'svg');
              svg.setAttribute('viewBox','0 0 640 180');
              svg.setAttribute('role','img');
              svg.setAttribute('aria-label','Graf tepové frekvence v průběhu aktivity');
              svg.style.cssText='display:block;width:100%;max-width:720px;height:auto;margin-top:8px';
              const minT=pairs[0][0],maxT=pairs[pairs.length-1][0];
              const minB=Math.floor(Math.min(...pairs.map(p=>p[1]))/10)*10;
              const maxB=Math.ceil(Math.max(...pairs.map(p=>p[1]))/10)*10;
              const x=t=>40+560*(t-minT)/Math.max(1,maxT-minT);
              const y=v=>150-125*(v-minB)/Math.max(1,maxB-minB);
              for(const value of [minB,Math.round((minB+maxB)/2),maxB]){
                const label=document.createElementNS(svgNS,'text');
                label.setAttribute('x','4');label.setAttribute('y',String(y(value)+4));
                label.setAttribute('font-size','13');label.setAttribute('fill','currentColor');
                label.textContent=String(value);
                svg.appendChild(label);
              }
              const path=document.createElementNS(svgNS,'polyline');
              path.setAttribute('points',pairs.map(p=>x(p[0]).toFixed(1)+','+y(p[1]).toFixed(1)).join(' '));
              path.setAttribute('fill','none');path.setAttribute('stroke','#e65c48');
              path.setAttribute('stroke-width','2');path.setAttribute('stroke-linejoin','round');
              svg.appendChild(path);
              panel.appendChild(svg);
              const timeLabel=document.createElement('div');
              timeLabel.className='muted tiny';
              timeLabel.textContent='Čas od začátku aktivity: '+Math.round(minT/60)+'–'+Math.round(maxT/60)+' min · Tep (bpm)';
              panel.appendChild(timeLabel);
            }
          }
          const toggle=document.createElement('button');
          toggle.type='button';
          toggle.textContent='Zobrazit detail';
          toggle.setAttribute('aria-expanded','false');
          toggle.style.marginTop='6px';
          toggle.onclick=()=>{
            panel.hidden=!panel.hidden;
            toggle.textContent=panel.hidden?'Zobrazit detail':'Skrýt detail';
            toggle.setAttribute('aria-expanded',String(!panel.hidden));
          };
          item.appendChild(toggle);
          item.appendChild(panel);
          stravaActivityList.appendChild(item);
        }
        if(totalPages>1){
          const pagination=document.createElement('nav');
          pagination.setAttribute('aria-label','Stránkování cvičení');
          pagination.style.cssText='display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin:16px 0';
          const prev=document.createElement('button');
          prev.type='button';prev.textContent='← Předchozí';prev.disabled=stravaPage===0;
          prev.onclick=()=>{stravaPage--;loadStravaActivities();};
          const label=document.createElement('span');
          label.textContent='Stránka '+(stravaPage+1)+' / '+totalPages;
          const next=document.createElement('button');
          next.type='button';next.textContent='Další →';next.disabled=stravaPage>=totalPages-1;
          next.onclick=()=>{stravaPage++;loadStravaActivities();};
          pagination.append(prev,label,next);
          stravaActivityList.appendChild(pagination);
        }
      }catch(err){
        if(requestId===stravaListRequest&&auth.currentUser?.uid===OWNER_UID){
          window.radarApiActivities=[];
          document.dispatchEvent(new Event('radar:data-changed'));
          stravaListStatus.textContent='Načtení aktivit selhalo: '+err.message;
          const rows=document.getElementById('stravaRows');
          if(rows)rows.innerHTML='<tr><td colspan="7">Načtení Stravy selhalo. Zkus obnovit seznam v administraci.</td></tr>';
        }
      }finally{
        if(requestId===stravaListRequest)stravaRefreshList.disabled=auth.currentUser?.uid!==OWNER_UID;
      }
    }
    stravaRefreshList.onclick=()=>{stravaPublishRequested=true;void loadStravaActivities()};
    const stravaSyncButton=btn('stravaSyncButton');
    const stravaSyncStatus=btn('stravaSyncStatus');
    let stravaSyncRequest=0;
    stravaSyncButton.onclick=async()=>{
      const currentUser=auth.currentUser;
      if(!currentUser||currentUser.uid!==OWNER_UID){
        stravaSyncStatus.textContent='Nejdřív se přihlas jako administrátor.';
        return;
      }
      const requestId=++stravaSyncRequest;
      stravaSyncButton.disabled=true;
      stravaSyncStatus.textContent='Načítám posledních 30 aktivit ze Stravy…';
      try{
        const token=await currentUser.getIdToken();
        if(requestId!==stravaSyncRequest||auth.currentUser?.uid!==OWNER_UID)return;
        const response=await fetch('https://europe-west1-radarfit-25e17.cloudfunctions.net/stravaSync',{
          method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
          body:'{}',cache:'no-store'
        });
        const result=await response.json();
        if(requestId!==stravaSyncRequest||auth.currentUser?.uid!==OWNER_UID)return;
        if(!response.ok)throw Error('HTTP '+response.status+': '+String(result.error||'Synchronizace selhala'));
        stravaSyncStatus.textContent='Synchronizace dokončena: '+result.imported+' aktivit, '+result.withHeartRate+' s tepovou křivkou'+(result.streamErrors?' ('+result.streamErrors+' chyb načtení tepu)':'')+'.';
        stravaPublishRequested=true;
        await loadStravaActivities();
      }catch(err){
        if(requestId===stravaSyncRequest&&auth.currentUser?.uid===OWNER_UID)
          stravaSyncStatus.textContent='Synchronizace se nezdařila: '+err.message;
      }finally{
        if(requestId===stravaSyncRequest)stravaSyncButton.disabled=auth.currentUser?.uid!==OWNER_UID;
      }
    };
    btn('cloudSignOut').onclick=()=>signOut(auth);
    btn('cloudUpload').onclick=upload;
    btn('cloudDownload').onclick=download;
    onAuthStateChanged(auth,async u=>{
      ++stravaTestRequest;
      ++stravaConnectRequest;
      ++stravaSyncRequest;
      ++stravaListRequest;
      stravaRefreshList.disabled=true;
      stravaActivityList.replaceChildren();
      window.radarApiActivities=null;
      document.dispatchEvent(new Event('radar:data-changed'));
      stravaListStatus.textContent='Přihlas se pro načtení aktivit.';
      stravaSyncButton.disabled=true;
      stravaSyncStatus.textContent="Pro synchronizaci se přihlas do administrace.";
      stravaConnectButton.disabled=true;
      stravaConnectStatus.textContent="Pro propojení se přihlas do administrace.";
      stravaTestButton.disabled=true;
      stravaTestStatus.textContent='Pro test se přihlas do administrace.';
      if(unsubscribe){unsubscribe();unsubscribe=null}
      user=u;active=false;pending=false;clearTimeout(writeTimer);
      login.hidden=!!u;logged.hidden=!u;
      if(!u){window.radarAdminSetOwner?.(false);setStatus('Veřejný přehled je dostupný bez přihlášení. Pro úpravy se přihlas.');return}
      if(u.uid!==OWNER_UID){window.radarAdminSetOwner?.(false);setStatus('Tento účet nemá oprávnění spravovat RADAR.');await signOut(auth);return}
      window.radarAdminSetOwner?.(true);
      stravaTestButton.disabled=false;
      stravaConnectButton.disabled=false;
      stravaSyncButton.disabled=false;
      stravaRefreshList.disabled=false;
      stravaPublishRequested=true;
      void loadStravaActivities();
      stravaSyncStatus.textContent='Kontroluji datum poslední synchronizace Stravy…';
      // Automatically refresh on admin sign-in if the last successful sync is older than 6 hours.
      // The server-side sync endpoint is owner-authenticated and imports only recent activities.
      void (async()=>{
        try{
          const statusSnapshot=await get(ref(db,'users/'+OWNER_UID+'/stravaSyncStatus'));
          if(auth.currentUser?.uid!==OWNER_UID)return;
          const last=Date.parse(String(statusSnapshot.val()?.lastSyncAt||''));
          if(!Number.isFinite(last)||Date.now()-last>=6*60*60*1000){
            stravaSyncStatus.textContent='Automaticky aktualizuji Stravu (posledních 30 aktivit)…';
            stravaSyncButton.click();
          }else{
            stravaSyncStatus.textContent='Strava je aktuální. Poslední synchronizace: '+new Date(last).toLocaleString('cs-CZ')+'.';
          }
        }catch(err){
          if(auth.currentUser?.uid===OWNER_UID)stravaSyncStatus.textContent='Automatická kontrola Stravy se nezdařila: '+err.message+'. Ruční synchronizace je dostupná.';
        }
      })();
      stravaConnectStatus.textContent="Připraveno k propojení Stravy.";
      stravaTestStatus.textContent='Připraveno k ověření přístupu.';
      btn('cloudPassword').value='';
      btn('cloudUser').textContent='Přihlášený účet: '+(u.email||u.uid);
      setStatus('Kontroluji cloudová data…');
      try{
        const snap=await get(dataRef());if(user?.uid!==u.uid)return;
        remoteExists=snap.exists()&&!!snap.val().data;
        const hasLink=localStorage.getItem(linkedKey)===u.uid;
        const unchanged=localStorage.getItem(hashKey)===currentHash();
        if(hasLink&&unchanged&&remoteExists){
          applyRemote(snap.val());connect();
        }else{
          setStatus(remoteExists?'Cloudová data existují. Vyber, zda použít data z tohoto zařízení, nebo stáhnout cloudovou verzi.':'Cloud je prázdný. Na zařízení s původními daty zvol „Nahrát místní data do cloudu“.');
        }
      }catch(err){setStatus('Nepodařilo se načíst cloud: '+err.message)}
    });
    window.addEventListener('online',()=>{if(pending)flush()});
  }catch(err){login.hidden=true;document.body.classList.remove('auth-pending');setStatus('Nepodařilo se načíst synchronizaci: '+err.message)}
}
