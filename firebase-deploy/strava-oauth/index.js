"use strict";

const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
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
