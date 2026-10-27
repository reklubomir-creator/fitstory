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
  setStatus('Cloud zatím není nastavený. Je potřeba připojit vlastní projekt Firebase; místní data zůstávají beze změny.');
}else{
  try{
    const {initializeApp}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const {getAuth,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    const {getDatabase,ref,get,onValue,set,serverTimestamp}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js');
    const app=initializeApp(config);
    const auth=getAuth(app),db=getDatabase(app);
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
        }catch(err){setStatus('Chyba načítání: '+err.message)}
      },err=>setStatus('Cloud není dostupný: '+err.message));
    }
    function connect(){
      active=true;pending=false;
      localStorage.setItem(linkedKey,user.uid);
      localStorage.setItem(hashKey,currentHash());
      subscribe();
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
    btn('cloudSignUp').onclick=async()=>{
      try{await createUserWithEmailAndPassword(auth,btn('cloudEmail').value.trim(),btn('cloudPassword').value)}
      catch(err){setStatus('Vytvoření účtu selhalo: '+err.message)}
    };
    btn('cloudSignOut').onclick=()=>signOut(auth);
    btn('cloudUpload').onclick=upload;
    btn('cloudDownload').onclick=download;
    onAuthStateChanged(auth,async u=>{
      if(unsubscribe){unsubscribe();unsubscribe=null}
      user=u;active=false;pending=false;clearTimeout(writeTimer);
      login.hidden=!!u;logged.hidden=!u;
      if(!u){setStatus('Přihlas se pro synchronizaci. Místní data zůstávají dostupná.');return}
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
  }catch(err){login.hidden=true;setStatus('Nepodařilo se načíst synchronizaci: '+err.message)}
}
