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
      await set(publicRef,{weights,activity,exerciseList,updatedAt:new Date().toISOString()});
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
    btn('cloudSignIn').onclick=async()=>{
      try{await signInWithEmailAndPassword(auth,btn('cloudEmail').value.trim(),btn('cloudPassword').value)}
      catch(err){setStatus('Přihlášení selhalo: '+err.message)}
    };

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
        stravaActivityList.replaceChildren();
        stravaListStatus.textContent=activities.length?
          'Uloženo '+activities.length+' aktivit. Zobrazuji nejnovějších '+Math.min(activities.length,30)+'.':
          'Zatím nejsou uložené žádné aktivity.';
        const dateFormat=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'medium',timeStyle:'short'});
        for(const a of activities.slice(0,30)){
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
          description.textContent=a.description||'Popis aktivity zatím není importovaný. Pro jeho získání bude potřeba rozšířit serverovou synchronizaci.';
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
      }catch(err){
        if(requestId===stravaListRequest&&auth.currentUser?.uid===OWNER_UID)
          stravaListStatus.textContent='Načtení aktivit selhalo: '+err.message;
      }finally{
        if(requestId===stravaListRequest)stravaRefreshList.disabled=auth.currentUser?.uid!==OWNER_UID;
      }
    }
    stravaRefreshList.onclick=loadStravaActivities;
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
      void loadStravaActivities();
      stravaSyncStatus.textContent="Připraveno k synchronizaci aktivit ze Stravy.";
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
