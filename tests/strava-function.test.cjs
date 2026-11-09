const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const uid='M8VZmCpDslf5lJiziK5fHAsXnFg1',path='users/'+uid+'/stravaActivities';
async function execute({failPublication=false}={}){
 const records={
  'integrations/strava/owner':{accessToken:'test',refreshToken:'test-refresh',expiresAt:Date.now()/1000+3600},
  [path]:{'7':{id:7,startDate:'2026-11-08T12:00:00Z',description:'Warm Up\nSet 1: 20 kg x 10',averageHeartrate:120,maxHeartrate:150,heartRateStream:{time:[0,1,2],bpm:[120,130,140]}}},
  'public/radar':{weights:[{date:'2026-11-02',kg:126.5}],stravaExerciseList:[]}
 };
 const read=p=>{if(p===path+'/7')return records[path]['7'];if(p==='public/radar/weights')return records['public/radar'].weights;if(p==='public/radar/stravaExerciseList')return records['public/radar'].stravaExerciseList;return records[p]};
 const reference=p=>({child:key=>reference(p+'/'+key),get:async()=>({val:()=>structuredClone(read(p)??null)}),update:async patch=>{
  if(failPublication&&p==='public/radar')throw Error('Publication denied');
  const value=read(p)||{};Object.assign(value,structuredClone(patch));
  if(p===path+'/7')records[path]['7']=value;else records[p]=value;
 }});
 const sdk={onRequest:(options,handler)=>({options,handler}),onSchedule:(options,handler)=>({options,handler}),defineSecret:()=>({value:()=> 'test-secret'}),initializeApp(){},getApp:()=>({}),getAuth:()=>({verifyIdToken:async()=>({uid})}),getDatabase:()=>({ref:reference})};
 const sandbox={exports:{},require:name=>name==='node:crypto'?require(name):sdk,console:{info(){},warn(){},error(){}},URL,URLSearchParams,AbortSignal,fetch:async url=>({ok:true,status:200,json:async()=>url.includes('athlete/activities')?[{id:7,start_date:'2026-11-08T12:00:00Z',name:'Workout',has_heartrate:true,moving_time:3600}]:{time:{data:[0,1]},heartrate:{data:[120,130]}}})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../firebase-deploy/strava-oauth/index.js'),'utf8'),sandbox);
 const result={status(code){this.code=code;return this},set(){},json(value){this.value=value;return this}};
 await sandbox.exports.stravaSync.handler({method:'POST',headers:{authorization:'Bearer test'}},result);
 return {records,result,exports:sandbox.exports};
}
test('shared server import preserves description, full HR curve and metrics without duplicate IDs',async()=>{
 const {records,result}=await execute();assert.equal(result.code,200);assert.equal(result.value.success,true);assert.equal(Object.keys(records[path]).length,1);
 assert.equal(records[path]['7'].heartRateStream.bpm.length,3);assert.equal(records[path]['7'].averageHeartrate,120);assert.match(records[path]['7'].description,/Set 1/);
 assert.ok(records['public/radar'].stravaLastSyncAt);
});
test('server publication failure does not misreport completed private import',async()=>{
 const {result}=await execute({failPublication:true});assert.equal(result.value.success,true);assert.equal(result.value.published,false);
});
test('one existing scheduler declaration uses Prague 08:00 and 16:00',async()=>{
 const {exports}=await execute();assert.equal(exports.stravaDailySync.options.schedule,'0 8,16 * * *');assert.equal(exports.stravaDailySync.options.timeZone,'Europe/Prague');
});
