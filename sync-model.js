/* v0.4.31: pure three-way merge; no network or storage side effects. */
(function(root){
  const fields=['weights','workouts','foods','activities','milestones','body','labs'];
  const copy=x=>JSON.parse(JSON.stringify(x));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function normalize(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Neplatná cloudová data.');
    const out=copy(raw);
    for(const field of fields){
      // RTDB omits empty arrays entirely. Accept absence, reject malformed nonempty branches.
      const value=out[field];
      if(value==null)out[field]=[];
      else if(Array.isArray(value))out[field]=value.filter(x=>x!=null);
      else if(typeof value==='object'&&Object.keys(value).every(k=>/^\d+$/.test(k)))out[field]=Object.keys(value).sort((a,b)=>a-b).map(k=>value[k]);
      else throw Error('Neplatný formát historie: '+field);
    }
    return out;
  }
  function identity(field,item){
    if(field==='activities'&&item.id!=null)return String(item.id);
    if(field==='workouts')return String(item.date)+'|'+String(item.name||'');
    return String(item.date||item.id||JSON.stringify(item));
  }
  function indexed(field,items){
    const map=new Map();
    for(const item of items){const id=identity(field,item);if(map.has(id)&&!equal(map.get(id),item))throw Error('Konfliktní záznamy v '+field+': '+id);map.set(id,item)}
    return map;
  }
  function merge(remoteRaw,baseRaw,localRaw){
    const remote=normalize(remoteRaw),base=normalize(baseRaw),local=normalize(localRaw),out=copy(remote);
    for(const field of new Set([...Object.keys(base),...Object.keys(local)])){
      if(fields.includes(field)){
        const current=indexed(field,remote[field]),before=indexed(field,base[field]),after=indexed(field,local[field]);
        for(const id of new Set([...before.keys(),...after.keys()])){
          const old=before.get(id),next=after.get(id),cloud=current.get(id);
          if(equal(old,next))continue;
          if(!equal(cloud,old)&&!equal(cloud,next))throw Error('Konflikt '+field+' ('+id+'). Cloud i místní záznam zůstaly zachované; obnov data a zkontroluj obě hodnoty.');
          if(next===undefined)current.delete(id);else current.set(id,copy(next));
        }
        out[field]=[...current.values()];
      }else if(!equal(base[field],local[field])){
        if(!equal(remote[field],base[field])&&!equal(remote[field],local[field]))throw Error('Konflikt pole '+field);
        if(local[field]===undefined)delete out[field];else out[field]=copy(local[field]);
      }
    }
    return out;
  }
  // Unlinked browsers may contribute missing dates only. Same-date differences stay in recovery storage.
  function recoverWeights(remoteRaw,localRaw){
    const remote=normalize(remoteRaw),local=normalize(localRaw),known=new Map(remote.weights.map(w=>[w.date,w]));
    const conflicts=[];
    for(const w of local.weights){
      const old=known.get(w.date);
      if(!old){remote.weights.push(copy(w));known.set(w.date,w)}
      else if(Number(old.kg)!==Number(w.kg))conflicts.push(w.date);
    }
    return {data:remote,conflicts};
  }
  const api={normalize,merge,recoverWeights};
  if(typeof module!=='undefined')module.exports=api;
  else root.RadarSyncModel=api;
})(typeof window==='undefined'?globalThis:window);
