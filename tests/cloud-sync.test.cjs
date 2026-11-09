const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const model=require('../sync-model.js');
const uid='M8VZmCpDslf5lJiziK5fHAsXnFg1';
const privatePath='users/'+uid+'/radar';
const clone=x=>JSON.parse(JSON.stringify(x));
async function setup({local={weights:[]},denyPublic=false}={}){
 const elements=new Map(),timers=[],backups=[];
 const element=id=>{
  if(!elements.has(id))elements.set(id,{textContent:'',value:'',hidden:false,disabled:false,style:{},addEventListener(){},replaceChildren(){},append(){},appendChild(){},setAttribute(){},classList:{add(){}},parentNode:{insertBefore(){}}});
  return elements.get(id);
 };
 const history={weights:[{date:'2026-05-24',kg:170},{date:'2026-11-02',kg:126.5}]};
 const records={[privatePath]:{data:clone(history),updatedAt:123},'public/radar':{weights:clone(history.weights),stravaExerciseList:[{id:'strava-9',heartRate:{points:[[0,120],[1,125]]}}]},['users/'+uid+'/stravaSyncStatus']:{lastSyncAt:new Date().toISOString()}};
 const snap=value=>({val:()=>clone(value),exists:()=>value!=null});
 let authCallback,transactions=0;
 const auth={currentUser:{uid,email:'test@example.test',getIdToken:async()=> 'test-token'}};
 const sdk={initializeApp:()=>({}),getAuth:()=>auth,getDatabase:()=>({}),ref:(_,path)=>path,
  onAuthStateChanged:(_,fn)=>{authCallback=fn},
  get:async path=>{if(path.endsWith('/stravaActivities'))throw Error('simulated list refresh failure');return snap(records[path]??null)},
  onValue:(path,fn)=>{queueMicrotask(()=>fn(snap(records[path]??null)));return()=>{}},
  update:async()=>{throw Error('Unexpected blind database update')},
  runTransaction:async(path,fn)=>{
   transactions++;
   if(path==='public/radar'&&denyPublic)throw Error('PERMISSION_DENIED');
   const initial=fn(null);assert.equal(initial,null,'empty cache must retry without local seed');
   const isPrivate=path===privatePath+'/data';
   const current=isPrivate?records[privatePath].data:records[path];const next=fn(clone(current));
   if(next===undefined)return {committed:false,snapshot:snap(current)};
   if(isPrivate)records[privatePath].data=clone(next);else records[path]=clone(next);
   return {committed:true,snapshot:snap(next)};
  },serverTimestamp:()=>123,signOut:async()=>{},signInWithEmailAndPassword:async()=>{},createUserWithEmailAndPassword:async()=>{}};
 const localStore=new Map();
 const sandbox={data:clone(local),window:{RADAR_FIREBASE_CONFIG:{apiKey:'test',databaseURL:'https://example.test',projectId:'test'},RadarSyncModel:model,addEventListener(){}},document:{getElementById:element,createElement:()=>element('created-'+Math.random()),dispatchEvent(){},addEventListener(){},body:{classList:{contains:()=>false,remove(){}}}},
  localStorage:{getItem:k=>localStore.get(k)||null,setItem:(k,v)=>localStore.set(k,v)},render(){},Event:class{},console:{warn(){},error(){}},confirm:()=>true,
  indexedDB:{open(){const request={};queueMicrotask(()=>{request.result={transaction(){const tx={objectStore:()=>({put(value,key){backups.push({key,value:clone(value)});queueMicrotask(()=>tx.oncomplete?.())}})};return tx},close(){}};request.onsuccess()});return request}},
  setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},modules:sdk,fetch:async()=>({ok:true,status:200,json:async()=>({success:true,imported:30,withHeartRate:15})})};
 sandbox.window.window=sandbox.window;
 const code=fs.readFileSync(require.resolve('../cloud-sync.js'),'utf8').replace(/await import\('https:\/\/www\.gstatic\.com\/firebasejs\/[^']+'\)/g,'modules');
 vm.createContext(sandbox);await vm.runInContext('(async()=>{'+code+'})()',sandbox);
 await authCallback(auth.currentUser);await new Promise(setImmediate);
 return {sandbox,records,elements,backups,timers,transactions:()=>transactions,flush:async()=>{const fn=timers.pop();if(fn)await fn();await new Promise(setImmediate)}};
}
test('new browser automatically loads complete cloud history despite absent link/hash',async()=>{
 const h=await setup();assert.equal(h.sandbox.data.weights.length,2);assert.ok(h.backups.length);assert.equal(h.backups[0].value.localData.weights.length,0);
});
test('local-only new weigh-in survives login and publishes after safe append',async()=>{
 const h=await setup({local:{weights:[{date:'2026-11-09',kg:125}]}});
 await new Promise(setImmediate);
 assert.equal(h.records[privatePath].data.weights.length,3);
 assert.equal(h.records['public/radar'].weights.length,3);
 assert.equal(h.records['public/radar'].stravaExerciseList[0].id,'strava-9');
 assert.equal(h.backups[0].value.localData.weights[0].kg,125);
 assert.ok(new Set(h.backups.map(x=>x.key)).size===h.backups.length,'recovery snapshots are immutable');
});
test('save merges another device addition and reports publication failure separately',async()=>{
 const h=await setup({denyPublic:true});
 h.records[privatePath].data.weights.push({date:'2026-11-08',kg:125.5});
 h.sandbox.data.weights.push({date:'2026-11-09',kg:125});
 h.sandbox.window.radarCloudChanged();await h.flush();
 assert.equal(h.records[privatePath].data.weights.length,4);
 assert.match(h.elements.get('cloudStatus').textContent,/Zveřejnění SELHALO/);
});
test('successful Strava import remains successful when list refresh fails',async()=>{
 const h=await setup();await h.elements.get('stravaSyncButton').onclick();
 assert.match(h.elements.get('stravaSyncStatus').textContent,/Import Stravy dokončen/);
 assert.match(h.elements.get('stravaSyncStatus').textContent,/Obnovení seznamu selhalo/);
});
