"use strict";

const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp, getApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

initializeApp({databaseURL:"https://radarfit-25e17-default-rtdb.firebaseio.com"});
const OWNER_UID="M8VZmCpDslf5lJiziK5fHAsXnFg1";
const CLIENT_ID="293370";
const SECRET=defineSecret("STRAVA_CLIENT_SECRET");
const ORIGIN="https://reklubomir-creator.github.io";
const CALLBACK="https://europe-west1-radarfit-25e17.cloudfunctions.net/stravaCallback";
const STATE_PATH="integrations/strava/oauthState";
const TOKEN_PATH="integrations/strava/owner";
const options={region:"europe-west1",cors:[ORIGIN],maxInstances:2,memory:"256MiB"};

async function owner(req,res){
  const header=req.headers.authorization||"";
  if(!header.startsWith("Bearer ")){res.status(401).json({error:"Authentication required"});return false;}
  try{
    const token=await getAuth().verifyIdToken(header.slice(7),true);
    if(token.uid!==OWNER_UID){res.status(403).json({error:"Access denied"});return false;}
    return true;
  }catch{res.status(401).json({error:"Invalid authentication token"});return false;}
}

// RTDB REST ETag conditional requests perform an atomic compare-and-delete.
// Unlike the Admin SDK transaction, this never relies on an initial local-cache snapshot.
async function consumeOAuthState(state){
  const credential=getApp().options.credential;
  if(!credential||typeof credential.getAccessToken!=="function"){
    throw new Error("Firebase Admin credential cannot obtain access token");
  }
  const access=await credential.getAccessToken();
  const endpoint="https://radarfit-25e17-default-rtdb.firebaseio.com/"+STATE_PATH+".json";
  const read=await fetch(endpoint,{
    headers:{"Authorization":"Bearer "+access.access_token,"X-Firebase-ETag":"true"},
    signal:AbortSignal.timeout(15000)
  });
  if(!read.ok)throw new Error("State read HTTP "+read.status);
  const etag=read.headers.get("etag");
  if(!etag)throw new Error("Missing database ETag");
  const saved=await read.json();
  const hash=crypto.createHash("sha256").update(state).digest("hex");
  if(!saved||typeof saved.hash!=="string"||saved.hash.length!==hash.length||
     !crypto.timingSafeEqual(Buffer.from(saved.hash),Buffer.from(hash))||
     !Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now())return false;
  const deleted=await fetch(endpoint,{
    method:"DELETE",
    headers:{"Authorization":"Bearer "+access.access_token,"if-match":etag},
    signal:AbortSignal.timeout(15000)
  });
  if(deleted.status===412)return false;
  if(!deleted.ok)throw new Error("State conditional delete HTTP "+deleted.status);
  return true;
}

exports.stravaAdminCheck=onRequest(options,async(req,res)=>{
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!(await owner(req,res)))return;
  return res.status(200).json({success:true,message:"RADAR admin authentication verified",stravaClientId:CLIENT_ID});
});

exports.stravaConnect=onRequest(options,async(req,res)=>{
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!(await owner(req,res)))return;
  try{
    const state=crypto.randomBytes(32).toString("hex");
    const hash=crypto.createHash("sha256").update(state).digest("hex");
    await getDatabase().ref(STATE_PATH).set({hash,expiresAt:Date.now()+600000});
    const url=new URL("https://www.strava.com/oauth/authorize");
    for(const [key,value] of Object.entries({
      client_id:CLIENT_ID,redirect_uri:CALLBACK,response_type:"code",
      approval_prompt:"auto",scope:"read,activity:read_all",state
    }))url.searchParams.set(key,value);
    res.set("Cache-Control","no-store");
    return res.status(200).json({url:url.toString()});
  }catch(err){
    console.error("Strava OAuth initiation failed",err);
    return res.status(500).json({error:"Could not start Strava authorization"});
  }
});

exports.stravaCallback=onRequest({
  region:"europe-west1",secrets:[SECRET],maxInstances:2,memory:"256MiB"
},async(req,res)=>{
  res.set("Cache-Control","no-store");
  if(req.method!=="GET")return res.status(405).send("Method not allowed");
  const {state,code,error}=req.query;
  if(typeof state!=="string"||!/^[a-f0-9]{64}$/.test(state))
    return res.status(400).send("Neplatny autorizacni stav.");
  try{
    const consumed=await consumeOAuthState(state);
    if(!consumed)return res.status(400).send("Autorizace vyprsela nebo uz byla pouzita.");
    if(error)return res.status(400).send("Strava autorizace byla zamitnuta.");
    if(typeof code!=="string"||!code||code.length>2048)
      return res.status(400).send("Chybi autorizacni kod.");
    const response=await fetch("https://www.strava.com/oauth/token",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:CLIENT_ID,client_secret:SECRET.value(),code,grant_type:"authorization_code"
      }),
      signal:AbortSignal.timeout(15000)
    });
    if(!response.ok){
      console.error("Strava token exchange failed",response.status);
      return res.status(502).send("Strava autorizaci se nepodarilo dokoncit.");
    }
    const token=await response.json();
    if(!token.access_token||!token.refresh_token||
       !Number.isFinite(token.expires_at)||!Number.isFinite(token.athlete?.id))
      return res.status(502).send("Strava vratila nekompletni odpoved.");
    await getDatabase().ref(TOKEN_PATH).set({
      accessToken:token.access_token,refreshToken:token.refresh_token,
      expiresAt:token.expires_at,athleteId:token.athlete.id,
      connectedAt:new Date().toISOString()
    });
    return res.status(200).type("html").send(
      '<!doctype html><html lang="cs"><meta charset="utf-8"><title>Strava propojena</title>'+
      '<body><h1>Strava je propojena</h1><p>Autorizace byla uspesna.</p></body></html>'
    );
  }catch(err){
    console.error("Strava callback failed",err);
    return res.status(500).send("Propojeni se nepodarilo dokoncit.");
  }
});

/**
 * Owner-only manual import. Activity data is stored privately, not published.
 * Initial scope: newest 30 activities, and heart-rate streams when available.
 */
// Shared import engine used by the owner-only HTTP endpoint and the daily scheduler.
async function importStravaActivities(){
  const tokenRef=getDatabase().ref(TOKEN_PATH);
  const saved=(await tokenRef.get()).val();
  if(!saved?.refreshToken)throw new Error("Strava not connected");
  let accessToken=saved.accessToken;
  if(!accessToken||!Number.isFinite(saved.expiresAt)||saved.expiresAt<Date.now()/1000+120){
    const refresh=await fetch("https://www.strava.com/oauth/token",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:CLIENT_ID,client_secret:SECRET.value(),
        grant_type:"refresh_token",refresh_token:saved.refreshToken
      }),signal:AbortSignal.timeout(15000)
    });
    if(!refresh.ok)throw new Error("Strava token refresh HTTP "+refresh.status);
    const refreshed=await refresh.json();
    if(!refreshed.access_token||!refreshed.refresh_token||!Number.isFinite(refreshed.expires_at))
      throw new Error("Invalid Strava refresh response");
    accessToken=refreshed.access_token;
    await tokenRef.update({accessToken,refreshToken:refreshed.refresh_token,expiresAt:refreshed.expires_at});
  }
  const api=async url=>{
    const response=await fetch(url,{headers:{Authorization:"Bearer "+accessToken},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error("Strava API HTTP "+response.status);
    return response.json();
  };
  const activities=await api("https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1");
  if(!Array.isArray(activities))throw new Error("Invalid Strava activities response");
  const ref=getDatabase().ref("users/"+OWNER_UID+"/stravaActivities");
  let imported=0,withHeartRate=0,streamErrors=0;
  for(const activity of activities){
    if(!Number.isSafeInteger(activity.id)||activity.id<=0)continue;
    const record={
      id:activity.id,name:String(activity.name||""),
      type:String(activity.type||""),sportType:String(activity.sport_type||""),
      startDate:String(activity.start_date||""),
      movingTime:Number(activity.moving_time)||0,
      elapsedTime:Number(activity.elapsed_time)||0,
      distance:Number(activity.distance)||0,
      totalElevationGain:Number(activity.total_elevation_gain)||0,
      averageHeartrate:Number.isFinite(activity.average_heartrate)?activity.average_heartrate:null,
      maxHeartrate:Number.isFinite(activity.max_heartrate)?activity.max_heartrate:null,
      hasHeartrate:Boolean(activity.has_heartrate),
      importedAt:new Date().toISOString()
    };
    if(record.hasHeartrate){
      try{
        const streams=await api("https://www.strava.com/api/v3/activities/"+activity.id+
          "/streams?keys=time,heartrate&key_by_type=true");
        if(Array.isArray(streams?.heartrate?.data)&&Array.isArray(streams?.time?.data)){
          const n=Math.min(streams.heartrate.data.length,streams.time.data.length,20000);
          record.heartRateStream={time:streams.time.data.slice(0,n),bpm:streams.heartrate.data.slice(0,n)};
          withHeartRate++;
        }
      }catch(err){streamErrors++;console.warn("Strava HR stream unavailable",activity.id);}
    }
    await ref.child(String(activity.id)).update(record);
    imported++;
  }
  await getDatabase().ref("users/"+OWNER_UID+"/stravaSyncStatus").set({
    lastSyncAt:new Date().toISOString(),imported,withHeartRate,streamErrors,source:"firebase"
  });
  return {success:true,imported,withHeartRate,streamErrors};
}

exports.stravaDailySync=onSchedule({
  schedule:"0 7 * * *",timeZone:"Europe/Prague",region:"europe-west1",
  secrets:[SECRET],timeoutSeconds:540,memory:"256MiB",maxInstances:1,
  retryCount:0
},async()=>{
  try{
    const result=await importStravaActivities();
    console.info("Daily Strava sync completed",result.imported,result.withHeartRate,result.streamErrors);
  }catch(err){
    console.error("Daily Strava sync failed",err.message);
    throw err;
  }
});

exports.stravaSync=onRequest({
  ...options,secrets:[SECRET],timeoutSeconds:120
},async(req,res)=>{
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!(await owner(req,res)))return;
  res.set("Cache-Control","no-store");
  try{
    const tokenRef=getDatabase().ref(TOKEN_PATH);
    const saved=(await tokenRef.get()).val();
    if(!saved?.refreshToken)return res.status(409).json({error:"Strava not connected"});
    let accessToken=saved.accessToken;
    if(!accessToken||!Number.isFinite(saved.expiresAt)||saved.expiresAt<Date.now()/1000+120){
      const refresh=await fetch("https://www.strava.com/oauth/token",{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({
          client_id:CLIENT_ID,client_secret:SECRET.value(),
          grant_type:"refresh_token",refresh_token:saved.refreshToken
        }),signal:AbortSignal.timeout(15000)
      });
      if(!refresh.ok){
        console.error("Strava refresh failed",refresh.status);
        return res.status(502).json({error:"Strava token refresh failed",status:refresh.status});
      }
      const refreshed=await refresh.json();
      if(!refreshed.access_token||!refreshed.refresh_token||!Number.isFinite(refreshed.expires_at))
        throw new Error("Invalid Strava refresh response");
      accessToken=refreshed.access_token;
      await tokenRef.update({
        accessToken,refreshToken:refreshed.refresh_token,expiresAt:refreshed.expires_at
      });
    }
    const api=async(url)=>{
      const response=await fetch(url,{
        headers:{Authorization:"Bearer "+accessToken},
        signal:AbortSignal.timeout(15000)
      });
      if(!response.ok){
        const error=new Error("Strava API HTTP "+response.status);
        error.status=response.status;
        throw error;
      }
      return response.json();
    };
    const activities=await api("https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1");
    if(!Array.isArray(activities))throw new Error("Invalid Strava activities response");
    const ref=getDatabase().ref("users/"+OWNER_UID+"/stravaActivities");
    let imported=0,withHeartRate=0,streamErrors=0;
    for(const activity of activities){
      if(!Number.isSafeInteger(activity.id)||activity.id<=0)continue;
      const record={
        id:activity.id,name:String(activity.name||""),
        type:String(activity.type||""),sportType:String(activity.sport_type||""),
        startDate:String(activity.start_date||""),
        movingTime:Number(activity.moving_time)||0,
        elapsedTime:Number(activity.elapsed_time)||0,
        distance:Number(activity.distance)||0,
        totalElevationGain:Number(activity.total_elevation_gain)||0,
        averageHeartrate:Number.isFinite(activity.average_heartrate)?activity.average_heartrate:null,
        maxHeartrate:Number.isFinite(activity.max_heartrate)?activity.max_heartrate:null,
        hasHeartrate:Boolean(activity.has_heartrate),
        importedAt:new Date().toISOString()
      };
      if(record.hasHeartrate){
        try{
          const streams=await api("https://www.strava.com/api/v3/activities/"+activity.id+
            "/streams?keys=time,heartrate&key_by_type=true");
          if(Array.isArray(streams?.heartrate?.data)&&Array.isArray(streams?.time?.data)){
            const n=Math.min(streams.heartrate.data.length,streams.time.data.length,20000);
            record.heartRateStream={
              time:streams.time.data.slice(0,n),
              bpm:streams.heartrate.data.slice(0,n)
            };
            withHeartRate++;
          }
        }catch(err){
          streamErrors++;
          console.warn("Strava HR stream unavailable",activity.id,err.status||"unknown");
        }
      }
      await ref.child(String(activity.id)).update(record);
      imported++;
    }
    await getDatabase().ref("users/"+OWNER_UID+"/stravaSyncStatus").set({
      lastSyncAt:new Date().toISOString(),imported,withHeartRate,streamErrors
    });
    return res.status(200).json({success:true,imported,withHeartRate,streamErrors});
  }catch(err){
    console.error("Strava sync failed",err.status||err.message);
    return res.status(502).json({error:"Strava sync failed",status:err.status||null});
  }
});
