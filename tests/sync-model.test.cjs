const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize,merge,recoverWeights}=require('../sync-model.js');
const state=weights=>normalize({weights,activities:[]});
test('RTDB omitted empty arrays and numeric objects normalize safely',()=>{
 assert.deepEqual(normalize({weights:{0:{date:'2026-01-01',kg:150}}}).activities,[]);
 assert.throws(()=>normalize({weights:'broken'}));
});
test('two devices append without losing history or unrelated fields',()=>{
 const base=state([{date:'2026-01-01',kg:150}]);
 const a=state([...base.weights,{date:'2026-02-01',kg:145}]);
 const b=state([...base.weights,{date:'2026-03-01',kg:140}]);
 a.extra={keep:true}; const result=merge(a,base,b);
 assert.equal(result.weights.length,3);assert.deepEqual(result.extra,{keep:true});
});
test('same-date concurrent edits abort instead of overwriting',()=>{
 const base=state([{date:'2026-01-01',kg:150}]);
 assert.throws(()=>merge(state([{date:'2026-01-01',kg:149}]),base,state([{date:'2026-01-01',kg:148}])));
});
test('stale local snapshot does not delete newly added cloud history',()=>{
 const base=state([{date:'2026-01-01',kg:150}]);const local=state(base.weights);
 local.foods=[{date:'2026-03-01',kcal:2200}];
 const remote=state([...base.weights,{date:'2026-02-01',kg:140}]);
 assert.equal(merge(remote,base,local).weights.length,2);
});
test('unlinked recovery adds missing weights and retains conflicting dates separately',()=>{
 const remote=state([{date:'2026-01-01',kg:150}]);
 const r=recoverWeights(remote,state([{date:'2026-01-01',kg:149},{date:'2026-11-09',kg:125}]));
 assert.equal(r.data.weights.length,2);assert.equal(r.data.weights[0].kg,150);assert.deepEqual(r.conflicts,['2026-01-01']);
});
test('explicit changes preserve complete activity heart-rate and descriptions',()=>{
 const base=state([]);base.activities=[{id:1,date:'2026-05-25',description:'keep',heartRate:{points:[[1,120],[2,130]]}}];
 const local=structuredClone(base);local.weights=[{date:'2026-11-09',kg:125}];
 assert.deepEqual(merge(base,base,local).activities,base.activities);
});
