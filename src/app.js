import { createClient } from "@supabase/supabase-js";

const LOCAL_CACHE_KEY = "stockCompetitionCollabCache_v1";
const CLIENT_ID_KEY = "stockCompetitionCollabClientId_v1";
const CLIENT_NAME_KEY = "stockCompetitionCollabClientName_v1";
const SHARED_ROUND_KEY = "stockCompetitionCollabRound_v1";
const TECH_LAYER_KEY = "stockCompetitionTechLayers_v2";

const nowISO = () => new Date().toISOString();
const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const numeric = value => value === "" || value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const fmtPrice = value => numeric(value) === null ? "-" : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const fmtPct = value => numeric(value) === null ? "-" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const fmtDate = value => value ? String(value).slice(0,10) : "-";
const fmtDateTime = value => { if (!value) return "-"; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("zh-CN", { hour12:false }); };
const pctClass = value => numeric(value) === null ? "" : Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
const activeParticipants = () => state.participants.filter(item => item.status !== "inactive");
const getRound = id => state.rounds.find(item => item.id === id);
const getPick = (roundId, participantId) => state.picks.find(item => item.roundId === roundId && item.participantId === participantId);

function defaultState(){
  return {
    version:1,
    settings:{competitionName:"每日选股擂台",allowDuplicate:true,unsubmittedReturn:0,pointRule:"rank",ruleNote:"T日选股，T+1日开盘价买入，T+2日开盘价卖出；收益率=(T+2开盘价÷T+1开盘价-1)×100%。"},
    participants:[],rounds:[],picks:[],
    meta:{settingsUpdatedAt:new Date(0).toISOString(),deleted:{participants:{},rounds:{},picks:{}}}
  };
}

function normalizeState(input){
  const base=defaultState(); const source=input&&typeof input==="object"?input:{};
  const output={
    version:1,
    settings:{...base.settings,...(source.settings||{})},
    participants:Array.isArray(source.participants)?source.participants.map(item=>({...item,updatedAt:item.updatedAt||item.createdAt||nowISO()})):[],
    rounds:Array.isArray(source.rounds)?source.rounds.map(item=>({...item,status:item.status||"open",updatedAt:item.updatedAt||item.createdAt||nowISO()})):[],
    picks:Array.isArray(source.picks)?source.picks.map(item=>{const normalized={...item,updatedAt:item.updatedAt||item.createdAt||nowISO()};if(!normalized.technicalAnalysisError&&String(normalized.marketError||"").startsWith("技术分析：")){normalized.technicalAnalysisError=normalized.marketError;normalized.marketError="";}return normalized;}):[],
    meta:{...base.meta,...(source.meta||{}),deleted:{...base.meta.deleted,...(source.meta?.deleted||{})}}
  };
  for(const key of ["participants","rounds","picks"]) output.meta.deleted[key]={...(source.meta?.deleted?.[key]||{})};
  return output;
}

function storageGet(key){try{return localStorage.getItem(key);}catch{return null;}}
function storageSet(key,value){try{localStorage.setItem(key,value);}catch{}}
function loadLocal(){try{return normalizeState(JSON.parse(storageGet(LOCAL_CACHE_KEY)||"null"));}catch{return defaultState();}}
function saveLocal(){storageSet(LOCAL_CACHE_KEY,JSON.stringify(state));}
function clientId(){let id=storageGet(CLIENT_ID_KEY);if(!id){id=`visitor_${crypto.randomUUID?.()||uid("v")}`;storageSet(CLIENT_ID_KEY,id);}return id;}
let visitorName=storageGet(CLIENT_NAME_KEY)||`访客-${clientId().slice(-4).toUpperCase()}`;
let state=loadLocal();
let remoteRevision=0,dirty=false,syncing=false,saveTimer=null,pollTimer=null,pendingRemote=null,realtimeChannel=null;
let sharedRoundId=storageGet(SHARED_ROUND_KEY)||"";
const technicalCache=new Map();
let analysisBatchRunning=false;
let techLayers={ma5:true,ma10:false,ma20:true,ma30:false,ma50:false,ma90:false,ma105:false,ma180:false,macd:false,shIndex:false};
try{techLayers={...techLayers,...JSON.parse(storageGet(TECH_LAYER_KEY)||"{}")};}catch{}

const APP_CONFIG=window.APP_CONFIG||{};
const SUPABASE_URL=String(APP_CONFIG.supabaseUrl||"").trim();
const SUPABASE_PUBLISHABLE_KEY=String(APP_CONFIG.supabasePublishableKey||"").trim();
const supabaseConfigured=/^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL)&&SUPABASE_PUBLISHABLE_KEY.length>20;
const supabase=supabaseConfigured?createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  realtime:{params:{eventsPerSecond:10}},
  global:{headers:{"x-client-info":"stock-competition-collab/1.0"}}
}):null;

function entityTime(item){const t=Date.parse(item?.updatedAt||item?.createdAt||0);return Number.isFinite(t)?t:0;}
function mergeDeleted(a,b){const out={participants:{},rounds:{},picks:{}};for(const type of Object.keys(out)){for(const src of [a?.[type]||{},b?.[type]||{}])for(const [id,time] of Object.entries(src)){if(Date.parse(time||0)>Date.parse(out[type][id]||0))out[type][id]=time;}}return out;}
function mergeEntityArray(local,remote,type,deleted){
  const map=new Map();
  for(const item of [...(remote||[]),...(local||[])]){const current=map.get(item.id);if(!current||entityTime(item)>=entityTime(current))map.set(item.id,item);}
  return [...map.values()].filter(item=>Date.parse(deleted?.[type]?.[item.id]||0)<entityTime(item));
}
function mergeStates(local,remote){
  const l=normalizeState(local),r=normalizeState(remote); const deleted=mergeDeleted(l.meta.deleted,r.meta.deleted);
  const settingsLocal=Date.parse(l.meta.settingsUpdatedAt||0)>=Date.parse(r.meta.settingsUpdatedAt||0);
  return normalizeState({
    version:1,
    settings:settingsLocal?l.settings:r.settings,
    participants:mergeEntityArray(l.participants,r.participants,"participants",deleted),
    rounds:mergeEntityArray(l.rounds,r.rounds,"rounds",deleted),
    picks:mergeEntityArray(l.picks,r.picks,"picks",deleted),
    meta:{settingsUpdatedAt:settingsLocal?l.meta.settingsUpdatedAt:r.meta.settingsUpdatedAt,deleted}
  });
}

function setSyncStatus(kind,text){const pill=document.getElementById("syncPill"),label=document.getElementById("syncText");if(!pill||!label)return;pill.className=`sync-pill ${kind}`;label.textContent=text;}
function updateLastEditor(record){const el=document.getElementById("lastEditorText");if(!el)return;el.textContent=record?.updatedAt?`最近修改：${record.updatedBy?.name||"匿名访客"} · ${fmtDateTime(record.updatedAt)}`:"尚无在线修改记录";}
function isEditing(){return !!document.querySelector(".modal-backdrop.show")||["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName);}

async function apiJSON(url,options={}){const response=await fetch(url,{cache:"no-store",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});let payload;try{payload=await response.json();}catch{payload={ok:false,error:`HTTP ${response.status}`};}if(!response.ok||payload?.ok===false){const err=new Error(payload?.error||`HTTP ${response.status}`);err.status=response.status;err.payload=payload;throw err;}return payload;}

function configError(){return "尚未配置 Supabase。请在 Netlify 环境变量中填写 SUPABASE_URL 和 SUPABASE_PUBLISHABLE_KEY，并重新部署。";}
function normalizeRemoteRow(row){
  if(!row)return null;
  return {
    exists:true,
    revision:Number(row.revision||0),
    updatedAt:row.updated_at||null,
    updatedBy:row.updated_by&&typeof row.updated_by==="object"?row.updated_by:null,
    state:normalizeState(row.payload)
  };
}
async function fetchRemoteRow(){
  if(!supabase)throw new Error(configError());
  const {data,error}=await supabase.from("competition_state").select("id,revision,payload,updated_at,updated_by").eq("id","main").maybeSingle();
  if(error)throw error;
  return normalizeRemoteRow(data);
}
function remoteErrorText(error){
  const message=String(error?.message||error||"未知错误");
  if(/relation .*competition_state.* does not exist/i.test(message)||/Could not find the table/i.test(message))return "Supabase 数据表尚未创建，请在 SQL Editor 运行 supabase/schema.sql。";
  if(/row-level security|permission denied|42501/i.test(`${message} ${error?.code||""}`))return "Supabase RLS 权限未配置，请重新运行 supabase/schema.sql。";
  if(/Failed to fetch|NetworkError|fetch failed/i.test(message))return "无法连接 Supabase，请检查项目地址、Publishable Key 和网络。";
  return message;
}

async function loadRemote({initial=false,forceApply=false}={}){
  if(!supabase){setSyncStatus("error",configError());return;}
  try{
    setSyncStatus("saving",initial?"正在连接 Supabase…":"正在检查远程更新…");
    const record=await fetchRemoteRow();
    if(!record){
      remoteRevision=0;
      dirty=true;
      await saveRemote();
      return;
    }
    remoteRevision=record.revision;updateLastEditor(record);
    const remote=record.state;
    if(dirty){state=mergeStates(state,remote);saveLocal();renderAll();await saveRemote();return;}
    if(isEditing()&&!forceApply){pendingRemote=record;setSyncStatus("saving","有其他用户更新，完成当前编辑后应用");return;}
    state=remote;saveLocal();renderAll();setSyncStatus("online","在线 · Supabase 已同步");
  }catch(error){setSyncStatus("offline",`离线缓存 · ${remoteErrorText(error)}`);}
}

function applyPendingRemote(){if(!pendingRemote||isEditing())return;state=mergeStates(state,pendingRemote.state);remoteRevision=pendingRemote.revision||remoteRevision;updateLastEditor(pendingRemote);pendingRemote=null;saveLocal();renderAll();setSyncStatus("online","在线 · 已应用其他用户修改");}

function markChanged(message="已修改"){
  dirty=true;saveLocal();renderAll();setSyncStatus("saving",`${message} · 等待同步`);clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveRemote(),550);
}

async function saveRemote(retry=true){
  if(syncing||!dirty)return;
  if(!supabase){setSyncStatus("error",configError());return;}
  syncing=true;setSyncStatus("saving","正在保存到 Supabase…");
  const editor={id:clientId(),name:visitorName};
  try{
    let row=null;
    if(remoteRevision<=0){
      const {data,error}=await supabase.from("competition_state").insert({id:"main",revision:1,payload:state,updated_by:editor}).select("id,revision,payload,updated_at,updated_by").single();
      if(error){
        if(error.code==="23505"&&retry){const latest=await fetchRemoteRow();if(latest){remoteRevision=latest.revision;state=mergeStates(state,latest.state);saveLocal();renderAll();syncing=false;dirty=true;return saveRemote(false);}}
        throw error;
      }
      row=data;
    }else{
      const {data,error}=await supabase.from("competition_state").update({payload:state,updated_by:editor}).eq("id","main").eq("revision",remoteRevision).select("id,revision,payload,updated_at,updated_by").maybeSingle();
      if(error)throw error;
      if(!data&&retry){const latest=await fetchRemoteRow();if(latest){remoteRevision=latest.revision;state=mergeStates(state,latest.state);saveLocal();renderAll();syncing=false;dirty=true;return saveRemote(false);}}
      if(!data)throw new Error("保存时检测到其他用户同时修改，请重新同步");
      row=data;
    }
    const record=normalizeRemoteRow(row);remoteRevision=record.revision;dirty=false;updateLastEditor(record);setSyncStatus("online","在线 · Supabase 已同步");
  }catch(error){setSyncStatus("error",`同步失败 · ${remoteErrorText(error)}`);showToast("同步失败，修改已保存在本机缓存");}
  finally{syncing=false;}
}

async function handleIncomingRow(row){
  const record=normalizeRemoteRow(row);if(!record||record.revision<=remoteRevision)return;
  if(dirty){remoteRevision=record.revision;state=mergeStates(state,record.state);saveLocal();renderAll();await saveRemote();return;}
  if(isEditing()){pendingRemote=record;setSyncStatus("saving","有其他用户更新待应用");return;}
  state=record.state;remoteRevision=record.revision;saveLocal();renderAll();updateLastEditor(record);setSyncStatus("online","在线 · 已接收实时更新");
}

function startRealtime(){
  if(!supabase)return;
  realtimeChannel=supabase.channel("stock-competition-main")
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"competition_state",filter:"id=eq.main"},payload=>handleIncomingRow(payload.new))
    .on("postgres_changes",{event:"UPDATE",schema:"public",table:"competition_state",filter:"id=eq.main"},payload=>handleIncomingRow(payload.new))
    .subscribe(status=>{
      if(status==="SUBSCRIBED"&&!dirty)setSyncStatus("online","在线 · Supabase 实时同步");
      if(status==="CHANNEL_ERROR"||status==="TIMED_OUT")setSyncStatus("offline","实时连接暂不可用 · 将定时同步");
    });
}

async function pollRemote(){
  if(document.hidden||syncing||!supabase)return;
  try{const record=await fetchRemoteRow();if(record&&record.revision>remoteRevision)await handleIncomingRow({id:"main",revision:record.revision,payload:record.state,updated_at:record.updatedAt,updated_by:record.updatedBy});}
  catch{setSyncStatus("offline","网络暂时不可用 · 使用本机缓存");}
}

function ensureMeta(){state.meta=state.meta||{};state.meta.deleted=state.meta.deleted||{participants:{},rounds:{},picks:{}};for(const key of ["participants","rounds","picks"])state.meta.deleted[key]=state.meta.deleted[key]||{};}
function tombstone(type,id){ensureMeta();state.meta.deleted[type][id]=nowISO();}
function removeEntity(type,id){state[type]=state[type].filter(item=>item.id!==id);tombstone(type,id);}

function sortedRounds(){return [...state.rounds].sort((a,b)=>String(b.pickDate).localeCompare(String(a.pickDate)));}
function ensureSharedRound(){const valid=state.rounds.some(r=>r.id===sharedRoundId);if(!valid)sharedRoundId=sortedRounds()[0]?.id||"";storageSet(SHARED_ROUND_KEY,sharedRoundId);}
function setSharedRound(id){sharedRoundId=id||"";storageSet(SHARED_ROUND_KEY,sharedRoundId);renderRoundDependent();}

function returnInfo(pick){
  const buy=numeric(pick?.buyPrice),sell=numeric(pick?.sellPrice),current=numeric(pick?.currentPrice);
  if(buy&&sell)return{value:(sell/buy-1)*100,isTemporary:false};
  if(buy&&current)return{value:(current/buy-1)*100,isTemporary:true};
  return{value:null,isTemporary:false};
}

function dailyRows(roundId){
  const participants=activeParticipants();const rows=participants.map(participant=>{const pick=getPick(roundId,participant.id);const info=returnInfo(pick);return{participant,pick,returnPct:pick?info.value:Number(state.settings.unsubmittedReturn||0),isTemporary:!!pick&&info.isTemporary,isMissing:!!pick&&info.value===null,isUnsubmitted:!pick};});
  rows.sort((a,b)=>{const av=a.returnPct===null?-Infinity:a.returnPct,bv=b.returnPct===null?-Infinity:b.returnPct;return bv-av||a.participant.name.localeCompare(b.participant.name,"zh-CN");});
  rows.forEach((row,index)=>{row.rank=index+1;row.points=rows.length-index;});return rows;
}

function totalRows(){
  const settled=state.rounds.filter(r=>r.status==="settled").sort((a,b)=>String(a.pickDate).localeCompare(String(b.pickDate)));
  const rows=activeParticipants().map(participant=>{let equity=1,points=0,days=0,wins=0;for(const round of settled){const row=dailyRows(round.id).find(x=>x.participant.id===participant.id);if(!row||row.isTemporary||row.isMissing)continue;equity*=1+Number(row.returnPct||0)/100;points+=row.points||0;days+=1;if(row.rank===1)wins+=1;}return{participant,compoundReturn:(equity-1)*100,points,days,wins};});
  rows.sort((a,b)=>b.compoundReturn-a.compoundReturn||b.points-a.points);rows.forEach((row,index)=>row.rank=index+1);return rows;
}
function renderAll(){
  ensureSharedRound();
  document.title=`${state.settings.competitionName}｜Supabase在线共创版`;
  renderDashboard();renderParticipants();renderRounds();renderRoundSelects();renderRoundDependent();renderTotal();renderSummarySelect();renderSummary();renderData();
}
function renderRoundDependent(){renderPicks();renderSettlement();renderDaily();}

function renderDashboard(){
  const total=totalRows();const leader=total[0];const settled=state.rounds.filter(r=>r.status==="settled").length;
  const stats=[
    ["参赛者",activeParticipants().length,"当前有效选手"],
    ["比赛日",state.rounds.length,`已结算 ${settled} 日`],
    ["选股记录",state.picks.length,"Supabase共享"],
    ["当前领先",leader?.participant.name||"-",leader?fmtPct(leader.compoundReturn):"暂无成绩"]
  ];
  document.getElementById("dashboardStats").innerHTML=stats.map(([label,value,sub])=>`<div class="card stat"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`).join("");
  document.getElementById("overviewChart").innerHTML=overviewSVG();
  const rounds=sortedRounds().slice(0,6);document.getElementById("recentRounds").innerHTML=rounds.length?`<div class="table-wrap"><table style="min-width:520px"><thead><tr><th>T日</th><th>T+1</th><th>T+2</th><th>状态</th></tr></thead><tbody>${rounds.map(r=>`<tr><td>${fmtDate(r.pickDate)}</td><td>${fmtDate(r.buyDate)}</td><td>${fmtDate(r.sellDate)}</td><td><span class="badge ${r.status==="settled"?"success":"warning"}">${r.status==="settled"?"已结算":"进行中"}</span></td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">暂无比赛日</div>';
}

function overviewSVG(){
  const rounds=state.rounds.filter(r=>r.status==="settled").sort((a,b)=>String(a.pickDate).localeCompare(String(b.pickDate)));const participants=activeParticipants();
  if(!rounds.length||!participants.length)return'<div class="empty">完成正式结算后显示累计收益走势</div>';
  const width=760,height=280,m={l:50,r:18,t:18,b:36},iw=width-m.l-m.r,ih=height-m.t-m.b;
  const series=participants.map(p=>{let equity=1;return{participant:p,points:rounds.map(round=>{const row=dailyRows(round.id).find(x=>x.participant.id===p.id);if(row&&!row.isTemporary&&!row.isMissing)equity*=1+Number(row.returnPct||0)/100;return(equity-1)*100;})};});
  const vals=[0,...series.flatMap(s=>s.points)];let min=Math.min(...vals),max=Math.max(...vals);if(min===max){min-=1;max+=1;}const pad=(max-min)*.12;min-=pad;max+=pad;
  const x=i=>m.l+(rounds.length===1?iw/2:i/(rounds.length-1)*iw),y=v=>m.t+(max-v)/(max-min)*ih;
  const grids=Array.from({length:5},(_,i)=>{const v=min+(max-min)*i/4,yy=y(v);return`<line x1="${m.l}" y1="${yy}" x2="${width-m.r}" y2="${yy}" stroke="#e4e8f0"/><text x="${m.l-7}" y="${yy+3}" text-anchor="end" font-size="10" fill="#98a2b3">${v.toFixed(1)}%</text>`;}).join("");
  const paths=series.map(s=>{const color=s.participant.color||"#2563eb";const d=s.points.map((v,i)=>`${i?"L":"M"}${x(i)},${y(v)}`).join(" ");return`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>${s.points.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3.3" fill="#fff" stroke="${color}" stroke-width="2"><title>${escapeHtml(s.participant.name)} ${fmtDate(rounds[i].pickDate)} ${fmtPct(v)}</title></circle>`).join("")}`;}).join("");
  const labels=[0,Math.floor((rounds.length-1)/2),rounds.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>`<text x="${x(i)}" y="${height-10}" text-anchor="middle" font-size="10" fill="#667085">${fmtDate(rounds[i].pickDate).slice(5)}</text>`).join("");
  const legend=series.map(s=>`<span style="display:inline-flex;gap:5px;align-items:center"><i style="width:9px;height:9px;border-radius:50%;background:${s.participant.color||"#2563eb"}"></i>${escapeHtml(s.participant.name)} ${fmtPct(s.points.at(-1))}</span>`).join(" ");
  return`<div class="chart-box"><svg viewBox="0 0 ${width} ${height}">${grids}${paths}${labels}</svg></div><div class="muted" style="font-size:11px;margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">${legend}</div>`;
}

function renderParticipants(){
  const el=document.getElementById("participantsTable");if(!state.participants.length){el.innerHTML='<div class="empty">暂无参赛者</div>';return;}
  el.innerHTML=`<div class="table-wrap"><table><thead><tr><th>姓名</th><th>状态</th><th>选股次数</th><th>颜色</th><th>操作</th></tr></thead><tbody>${state.participants.map(p=>`<tr><td><strong>${escapeHtml(p.name)}</strong></td><td><span class="badge ${p.status==="active"?"success":""}">${p.status==="active"?"参赛中":"暂停"}</span></td><td>${state.picks.filter(x=>x.participantId===p.id).length}</td><td><span style="display:inline-block;width:18px;height:18px;border-radius:5px;background:${p.color||"#2563eb"}"></span></td><td><div class="actions"><button class="btn btn-small" onclick="openParticipantModal('${p.id}')">编辑</button><button class="btn btn-small btn-danger" onclick="deleteParticipant('${p.id}')">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function renderRounds(){
  const el=document.getElementById("roundsTable");const rounds=sortedRounds();if(!rounds.length){el.innerHTML='<div class="empty">暂无比赛日</div>';return;}
  el.innerHTML=`<div class="table-wrap"><table><thead><tr><th>T日</th><th>T+1买入</th><th>T+2卖出</th><th>选股数</th><th>状态</th><th>操作</th></tr></thead><tbody>${rounds.map(r=>`<tr><td>${fmtDate(r.pickDate)}</td><td>${fmtDate(r.buyDate)}</td><td>${fmtDate(r.sellDate)}</td><td>${state.picks.filter(p=>p.roundId===r.id).length}</td><td><span class="badge ${r.status==="settled"?"success":"warning"}">${r.status==="settled"?"已结算":"进行中"}</span></td><td><div class="actions"><button class="btn btn-small" onclick="setSharedRound('${r.id}');showPage('picks')">查看</button><button class="btn btn-small" onclick="openRoundModal('${r.id}')">编辑</button><button class="btn btn-small btn-danger" onclick="deleteRound('${r.id}')">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function renderRoundSelects(){
  const rounds=sortedRounds();const html=rounds.length?rounds.map(r=>`<option value="${r.id}">T ${fmtDate(r.pickDate)}｜T+1 ${fmtDate(r.buyDate)}｜T+2 ${fmtDate(r.sellDate)}${r.status==="settled"?"（已结算）":""}</option>`).join(""):'<option value="">暂无比赛日</option>';
  for(const id of ["roundSelectPicks","roundSelectSettlement","roundSelectDaily"]){const el=document.getElementById(id);if(el){el.innerHTML=html;el.value=sharedRoundId;}}
}

function renderPicks(){
  const el=document.getElementById("picksTable"),round=getRound(sharedRoundId);
  const batchButton=document.getElementById("analyzeAllBtn");
  if(batchButton){batchButton.disabled=analysisBatchRunning;batchButton.textContent=analysisBatchRunning?"分析中…":"分析全部";}
  if(!round){el.innerHTML='<div class="empty">请先新建比赛日</div>';return;}
  const picks=state.picks.filter(p=>p.roundId===round.id);
  if(!picks.length){el.innerHTML='<div class="empty">当前比赛日暂无选股</div>';return;}
  el.innerHTML=`<div class="notice" style="margin-bottom:12px">T日 ${fmtDate(round.pickDate)}；T+1 ${fmtDate(round.buyDate)}；T+2 ${fmtDate(round.sellDate)}</div><div class="table-wrap"><table><thead><tr><th>选手</th><th>股票</th><th>板块</th><th>当前价</th><th>技术评分</th><th>理由</th><th>操作</th></tr></thead><tbody>${picks.map(p=>{const person=state.participants.find(x=>x.id===p.participantId);const techError=p.technicalAnalysisError||"";const scoreCell=p.analysisSummary?`<span class="badge ${p.analysisSummary.score>=76?"success":p.analysisSummary.score<58?"warning":""}">${escapeHtml(p.analysisSummary.level)} · ${p.analysisSummary.score}/120</span>`:techError?`${errorButton(techError)}`:'<span class="badge">未分析</span>';return`<tr><td>${escapeHtml(person?.name||"未知")}</td><td><strong>${escapeHtml(p.stockCode)}</strong><br>${escapeHtml(p.stockName||"")}</td><td>${escapeHtml(p.sector||"-")}</td><td>${fmtPrice(p.currentPrice)}${p.marketError?`<div>${errorButton(p.marketError)}</div>`:""}</td><td>${scoreCell}</td><td>${escapeHtml(p.reason||"-")}</td><td><div class="actions"><button class="btn btn-small" onclick="openTechnical('${p.id}')">技术分析</button><button class="btn btn-small" onclick="refreshPickQuote('${p.id}',true)">行情</button><button class="btn btn-small" onclick="openPickModal('${p.id}')">编辑</button><button class="btn btn-small btn-danger" onclick="deletePick('${p.id}')">删除</button></div></td></tr>`;}).join("")}</tbody></table></div>`;
}

function renderSettlement(){
  const el=document.getElementById("settlementTable"),round=getRound(sharedRoundId);if(!round){el.innerHTML='<div class="empty">请先选择比赛日</div>';return;}
  const participants=activeParticipants();if(!participants.length){el.innerHTML='<div class="empty">暂无参赛者</div>';return;}
  el.innerHTML=`<div class="table-wrap"><table><thead><tr><th>选手</th><th>股票</th><th>T+1开盘价</th><th>T+2开盘价</th><th>当前价</th><th>收益率</th><th>状态</th></tr></thead><tbody>${participants.map(person=>{const p=getPick(round.id,person.id);if(!p)return`<tr><td>${escapeHtml(person.name)}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>${fmtPct(state.settings.unsubmittedReturn)}</td><td><span class="badge danger">未提交</span></td></tr>`;const info=returnInfo(p);return`<tr><td>${escapeHtml(person.name)}</td><td>${escapeHtml(p.stockCode)} ${escapeHtml(p.stockName||"")}${p.marketError?`<div>${errorButton(p.marketError)}</div>`:""}</td><td><input style="width:100px" type="number" step="0.001" value="${p.buyPrice??""}" onchange="updatePickPrice('${p.id}','buyPrice',this.value)"></td><td><input style="width:100px" type="number" step="0.001" value="${p.sellPrice??""}" onchange="updatePickPrice('${p.id}','sellPrice',this.value)"></td><td><input style="width:100px" type="number" step="0.001" value="${p.currentPrice??""}" onchange="updatePickPrice('${p.id}','currentPrice',this.value)"></td><td class="${pctClass(info.value)}">${fmtPct(info.value)}</td><td>${info.value===null?'<span class="badge warning">待录入</span>':info.isTemporary?'<span class="badge warning">临时收益</span>':'<span class="badge success">正式价格</span>'}</td></tr>`;}).join("")}</tbody></table></div>`;
}

function renderDaily(){
  const round=getRound(sharedRoundId),el=document.getElementById("dailyTable"),chart=document.getElementById("dailyBarChart");if(!round){el.innerHTML='<div class="empty">请选择比赛日</div>';chart.innerHTML="";return;}
  const rows=dailyRows(round.id);chart.innerHTML=dailyBarSVG(rows,round);el.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>名次</th><th>选手</th><th>股票</th><th>收益率</th><th>积分</th><th>状态</th></tr></thead><tbody>${rows.map(row=>`<tr><td class="rank-${row.rank}">第${row.rank}名</td><td>${escapeHtml(row.participant.name)}</td><td>${row.pick?`${escapeHtml(row.pick.stockCode)} ${escapeHtml(row.pick.stockName||"")}`:"-"}</td><td class="${pctClass(row.returnPct)}">${fmtPct(row.returnPct)}</td><td>${row.points}</td><td>${row.isUnsubmitted?'<span class="badge danger">未提交</span>':row.isMissing?'<span class="badge warning">待价格</span>':row.isTemporary?'<span class="badge warning">临时</span>':'<span class="badge success">正式</span>'}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">暂无排名数据</div>';
}

function dailyBarSVG(rows,round){const values=rows.filter(r=>numeric(r.returnPct)!==null);if(!values.length)return'<div class="empty">暂无可绘制成绩</div>';const width=760,rowH=42,height=Math.max(230,60+values.length*rowH),m={l:140,r:70,t:16,b:34},iw=width-m.l-m.r;let min=Math.min(0,...values.map(r=>r.returnPct)),max=Math.max(0,...values.map(r=>r.returnPct));if(min===max){min-=1;max+=1;}const pad=Math.max((max-min)*.08,.3);min-=pad;max+=pad;const x=v=>m.l+(v-min)/(max-min)*iw,zero=x(0);const bars=values.map((r,i)=>{const y=m.t+i*rowH+6,xx=x(r.returnPct),left=Math.min(zero,xx),w=Math.max(2,Math.abs(xx-zero)),color=r.participant.color||"#2563eb";return`<text x="${m.l-8}" y="${y+16}" text-anchor="end" font-size="11" fill="#344054">第${r.rank}名 ${escapeHtml(r.participant.name)}</text><rect x="${left}" y="${y}" width="${w}" height="23" rx="6" fill="${color}" opacity="${r.isTemporary?.55:.9}" ${r.isTemporary?'stroke="#f59e0b" stroke-width="2" stroke-dasharray="4 3"':""}/><text x="${r.returnPct>=0?xx+6:xx-6}" y="${y+16}" text-anchor="${r.returnPct>=0?"start":"end"}" font-size="11" font-weight="800" fill="#344054">${fmtPct(r.returnPct)}</text>`;}).join("");return`<div class="chart-box"><svg viewBox="0 0 ${width} ${height}"><line x1="${zero}" y1="${m.t}" x2="${zero}" y2="${height-m.b}" stroke="#98a2b3" stroke-dasharray="4 4"/>${bars}<text x="${m.l}" y="${height-9}" font-size="10" fill="#667085">${fmtDate(round.pickDate)} · 虚线柱为临时成绩</text></svg></div>`;}

function renderTotal(){const rows=totalRows(),el=document.getElementById("totalTable");el.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>总排名</th><th>选手</th><th>累计复利收益</th><th>总积分</th><th>正式比赛日</th><th>冠军次数</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="rank-${r.rank}">第${r.rank}名</td><td>${escapeHtml(r.participant.name)}</td><td class="${pctClass(r.compoundReturn)}"><strong>${fmtPct(r.compoundReturn)}</strong></td><td>${r.points}</td><td>${r.days}</td><td>${r.wins}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">暂无正式结算成绩</div>';}

function renderSummarySelect(){const el=document.getElementById("summaryParticipant"),current=el.value;el.innerHTML=state.participants.length?state.participants.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join(""):'<option value="">暂无参赛者</option>';if(state.participants.some(p=>p.id===current))el.value=current;}
function maxDrawdownFromReturns(returns){
  let equity=1,peak=1,maxDrawdown=0;
  for(const value of returns){equity*=1+Number(value||0)/100;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,(equity/peak-1)*100);}
  return maxDrawdown;
}
function longestReturnStreak(returns,predicate){let best=0,current=0;for(const value of returns){if(predicate(value)){current+=1;best=Math.max(best,current);}else current=0;}return best;}
function participantSummary(id){
  const participant=state.participants.find(p=>p.id===id);if(!participant)return null;
  const records=[...state.rounds].sort((a,b)=>String(a.pickDate).localeCompare(String(b.pickDate))).map(round=>{const pick=getPick(round.id,id),info=returnInfo(pick),row=dailyRows(round.id).find(r=>r.participant.id===id);return{round,pick,info,row,official:round.status==="settled"&&pick&&!info.isTemporary&&info.value!==null};});
  const official=records.filter(r=>r.official),returns=official.map(r=>Number(r.info.value));let eq=1;const equityPoints=official.map(record=>{eq*=1+Number(record.info.value||0)/100;return{date:record.round.pickDate,value:(eq-1)*100,daily:Number(record.info.value),stockCode:record.pick?.stockCode||"",stockName:record.pick?.stockName||""};});
  const sectors={};const participantPicks=state.picks.filter(p=>p.participantId===id);participantPicks.forEach(p=>sectors[p.sector||"未填写"]=(sectors[p.sector||"未填写"]||0)+1);
  const techScores=participantPicks.filter(p=>p.analysisSummary&&Number.isFinite(Number(p.analysisSummary.score))).map(p=>Number(p.analysisSummary.score));
  return{participant,records,official,returns,equityPoints,compound:(eq-1)*100,winRate:returns.length?returns.filter(v=>v>0).length/returns.length*100:0,avg:returns.length?avg(returns):null,best:returns.length?Math.max(...returns):null,worst:returns.length?Math.min(...returns):null,volatility:returns.length>=2?std(returns):returns.length?0:null,maxDrawdown:returns.length?maxDrawdownFromReturns(returns):null,longestWinStreak:longestReturnStreak(returns,v=>v>0),longestLossStreak:longestReturnStreak(returns,v=>v<0),participationRate:records.length?records.filter(r=>r.pick).length/records.length*100:0,sectors:Object.entries(sectors).sort((a,b)=>b[1]-a[1]),pickCount:participantPicks.length,avgTech:techScores.length?avg(techScores):null,analyzedCount:techScores.length};
}
function participantStyleProfile(summary){
  const s=summary,n=s.official.length,totalSectorPicks=s.sectors.reduce((sum,item)=>sum+item[1],0),topSector=s.sectors[0]?.[0]||"暂无",topSectorShare=totalSectorPicks?s.sectors[0][1]/totalSectorPicks*100:0;
  const volatility=Number(s.volatility||0),drawdown=Number(s.maxDrawdown||0),avgAbs=s.returns.length?avg(s.returns.map(Math.abs)):0;
  let title="均衡轮动型",risk="中等波动";
  if(n<3)title="数据积累中";
  else if(volatility<=2.8&&drawdown>=-5&&s.winRate>=55)title="稳健复利型";
  else if((s.avgTech||0)>=78&&(s.avg||0)>0)title="趋势进攻型";
  else if(volatility>=5.5||avgAbs>=5.5||drawdown<=-12)title="高弹性博弈型";
  else if(topSectorShare>=55)title="板块专注型";
  else if(s.winRate>=65)title="胜率驱动型";
  if(volatility<3&&drawdown>-6)risk="低波动";else if(volatility>=5.5||drawdown<=-12)risk="高波动";
  const momentum=s.returns.length>=3?avg(s.returns.slice(-3)):s.avg;
  const recentText=momentum===null?"近期趋势数据不足":momentum>1?"近期收益动能偏强":momentum<-1?"近期处于回撤阶段":"近期表现相对平稳";
  const sampleText=n?`基于 ${n} 个正式比赛日，累计收益 ${fmtPct(s.compound)}，胜率 ${fmtPct(s.winRate)}，单日平均收益 ${fmtPct(s.avg)}，收益波动 ${fmtPct(s.volatility)}，最大回撤 ${fmtPct(s.maxDrawdown)}。`:`当前尚无正式结算记录，暂时无法形成稳定风格判断。`;
  const sectorText=s.pickCount?`选股最集中在“${topSector}”，占全部选股约 ${topSectorShare.toFixed(0)}%。`:`尚未形成明确的板块偏好。`;
  const techText=s.avgTech===null?"技术分析样本不足。":`已分析 ${s.analyzedCount} 只股票，平均技术评分 ${s.avgTech.toFixed(1)} 分。`;
  const confidence=Math.min(100,Math.round(n/8*70+Math.min(30,s.analyzedCount/Math.max(1,s.pickCount)*30)));
  return{title,risk,confidence,description:`${sampleText}${sectorText}${techText}${recentText}。`,tags:[risk,`胜率 ${fmtPct(s.winRate)}`,`最长连胜 ${s.longestWinStreak} 场`,`主要板块 ${topSector}`,s.avgTech===null?"技术评分待积累":`技术均分 ${s.avgTech.toFixed(1)}`]};
}
function participantEquitySVG(summary){
  const series=[{date:"起点",value:0,daily:null,stockCode:"",stockName:""},...summary.equityPoints];
  if(series.length<2)return'<div class="empty">完成正式结算后显示个人累计收益曲线</div>';
  const width=840,height=300,m={l:54,r:18,t:20,b:42},iw=width-m.l-m.r,ih=height-m.t-m.b;const values=series.map(p=>p.value);let min=Math.min(0,...values),max=Math.max(0,...values);if(min===max){min-=1;max+=1;}const margin=Math.max((max-min)*.12,.5);min-=margin;max+=margin;const x=i=>m.l+i/(series.length-1)*iw,y=v=>m.t+(max-v)/(max-min)*ih,zeroY=y(0);const color=/^#[0-9a-f]{6}$/i.test(summary.participant.color||"")?summary.participant.color:"#2563eb";
  const grids=Array.from({length:5},(_,i)=>{const value=max-i/4*(max-min),yy=y(value);return`<line x1="${m.l}" y1="${yy}" x2="${width-m.r}" y2="${yy}" stroke="#e4e8f0"/><text x="${m.l-7}" y="${yy+3}" text-anchor="end" font-size="10" fill="#98a2b3">${value.toFixed(1)}%</text>`;}).join("");
  const linePath=series.map((point,index)=>`${index?"L":"M"}${x(index)},${y(point.value)}`).join(" ");const areaPath=`M${x(0)},${zeroY} ${series.map((point,index)=>`L${x(index)},${y(point.value)}`).join(" ")} L${x(series.length-1)},${zeroY} Z`;
  const circles=series.slice(1).map((point,index)=>{const i=index+1;return`<circle cx="${x(i)}" cy="${y(point.value)}" r="4" fill="#fff" stroke="${color}" stroke-width="2"><title>${fmtDate(point.date)} ${escapeHtml(point.stockCode)} ${escapeHtml(point.stockName)}｜单日 ${fmtPct(point.daily)}｜累计 ${fmtPct(point.value)}</title></circle>`;}).join("");
  const tickIndexes=[0,Math.floor((series.length-1)/2),series.length-1].filter((value,index,array)=>array.indexOf(value)===index);const labels=tickIndexes.map(i=>`<text x="${x(i)}" y="${height-12}" text-anchor="${i===0?"start":i===series.length-1?"end":"middle"}" font-size="10" fill="#667085">${i===0?"起点":fmtDate(series[i].date).slice(5)}</text>`).join("");
  return`<div class="chart-box"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(summary.participant.name)}累计收益曲线">${grids}<line x1="${m.l}" y1="${zeroY}" x2="${width-m.r}" y2="${zeroY}" stroke="#98a2b3" stroke-dasharray="5 5"/><path d="${areaPath}" fill="${color}" opacity=".08"/><path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}${labels}</svg></div><div class="summary-chart-meta"><span>最新累计 <strong class="${pctClass(summary.compound)}">${fmtPct(summary.compound)}</strong></span><span>最大回撤 <strong class="${pctClass(summary.maxDrawdown)}">${fmtPct(summary.maxDrawdown)}</strong></span><span>单日波动 <strong>${fmtPct(summary.volatility)}</strong></span><span>正式样本 <strong>${summary.official.length} 场</strong></span></div>`;
}
function renderSummary(){
  const el=document.getElementById("summaryContent"),id=document.getElementById("summaryParticipant").value,data=participantSummary(id);if(!data){el.innerHTML='<div class="card empty">暂无参赛者</div>';return;}
  const s=data,profile=participantStyleProfile(s),color=/^#[0-9a-f]{6}$/i.test(s.participant.color||"")?s.participant.color:"#2563eb";
  el.innerHTML=`<div class="card participant-profile" style="--profile-color:${color};margin-bottom:16px"><div class="profile-main"><div class="profile-kicker"><i class="profile-dot"></i>选手风格画像</div><h3 class="profile-title">${escapeHtml(s.participant.name)} · ${escapeHtml(profile.title)}</h3><p class="profile-description">${escapeHtml(profile.description)}</p><div class="profile-tags">${profile.tags.map(tag=>`<span class="profile-tag">${escapeHtml(tag)}</span>`).join("")}</div><div class="profile-note">风格画像仅根据本比赛中的历史记录自动生成，不构成投资建议。</div></div><div class="profile-score"><span>画像可信度</span><strong>${profile.confidence}%</strong><small>${s.official.length} 个正式样本</small></div></div><div class="card" style="margin-bottom:16px"><div class="section-title"><h3>个人累计收益曲线</h3><span class="muted">按正式比赛日复利计算</span></div>${participantEquitySVG(s)}</div><div class="card" style="margin-bottom:16px"><div class="summary-grid"><div class="summary-item"><span>累计收益</span><strong class="${pctClass(s.compound)}">${fmtPct(s.compound)}</strong></div><div class="summary-item"><span>胜率</span><strong>${fmtPct(s.winRate)}</strong></div><div class="summary-item"><span>日均收益</span><strong>${fmtPct(s.avg)}</strong></div><div class="summary-item"><span>平均技术评分</span><strong>${s.avgTech===null?"-":s.avgTech.toFixed(1)}</strong></div><div class="summary-item"><span>最佳单日</span><strong class="${pctClass(s.best)}">${fmtPct(s.best)}</strong></div><div class="summary-item"><span>最差单日</span><strong class="${pctClass(s.worst)}">${fmtPct(s.worst)}</strong></div><div class="summary-item"><span>最大回撤</span><strong class="${pctClass(s.maxDrawdown)}">${fmtPct(s.maxDrawdown)}</strong></div><div class="summary-item"><span>主要板块</span><strong>${escapeHtml(s.sectors[0]?.[0]||"-")}</strong></div></div></div><div class="grid grid-2"><div class="card"><div class="section-title"><h3>板块偏好</h3></div>${s.sectors.length?s.sectors.slice(0,8).map(([name,count])=>`<div class="summary-record"><span>${escapeHtml(name)}</span><strong>${count}次</strong></div>`).join(""):'<div class="empty">暂无板块数据</div>'}</div><div class="card"><div class="section-title"><h3>近期记录</h3></div>${s.records.slice(-8).reverse().map(r=>`<div class="summary-record"><span>${fmtDate(r.round.pickDate)} ${r.pick?`${escapeHtml(r.pick.stockCode)} ${escapeHtml(r.pick.stockName||"")}`:"未提交"}</span><strong class="${pctClass(r.info.value)}">${fmtPct(r.info.value)}</strong></div>`).join("")||'<div class="empty">暂无记录</div>'}</div></div>`;
}

function renderData(){document.getElementById("settingName").value=state.settings.competitionName||"";document.getElementById("settingUnsubmitted").value=state.settings.unsubmittedReturn??0;document.getElementById("settingDuplicate").value=String(state.settings.allowDuplicate!==false);document.getElementById("settingRule").value=state.settings.ruleNote||"";}
function openModal(id){document.getElementById(id)?.classList.add("show");}
function closeModal(id){document.getElementById(id)?.classList.remove("show");setTimeout(applyPendingRemote,0);}
function showToast(text){const el=document.getElementById("toast");el.textContent=text;el.classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>el.classList.remove("show"),2300);}
function showPage(name){document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${name}`));document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===name));document.getElementById("mobileTitle").textContent=document.querySelector(`#nav button[data-page="${name}"]`)?.textContent.trim()||"每日选股擂台";document.getElementById("sidebar").classList.remove("show");if(name==="summary")renderSummary();}

function openParticipantModal(id=""){
  const item=state.participants.find(p=>p.id===id);document.getElementById("participantModalTitle").textContent=item?"编辑参赛者":"添加参赛者";document.getElementById("participantId").value=item?.id||"";document.getElementById("participantName").value=item?.name||"";document.getElementById("participantColor").value=item?.color||"#2563eb";document.getElementById("participantStatus").value=item?.status||"active";openModal("participantModal");
}
function saveParticipant(){const id=document.getElementById("participantId").value,name=document.getElementById("participantName").value.trim();if(!name)return showToast("请输入姓名");const current=state.participants.find(p=>p.id===id);const item={...(current||{}),id:id||uid("person"),name,color:document.getElementById("participantColor").value,status:document.getElementById("participantStatus").value,createdAt:current?.createdAt||nowISO(),updatedAt:nowISO()};if(current)Object.assign(current,item);else state.participants.push(item);closeModal("participantModal");markChanged("参赛者已保存");}
function deleteParticipant(id){const p=state.participants.find(x=>x.id===id);if(!p||!confirm(`删除参赛者“${p.name}”及其全部选股记录？`))return;for(const pick of state.picks.filter(x=>x.participantId===id)){removeEntity("picks",pick.id);}removeEntity("participants",id);markChanged("参赛者已删除");}

function openRoundModal(id=""){
  const item=state.rounds.find(r=>r.id===id);document.getElementById("roundModalTitle").textContent=item?"编辑比赛日":"新建比赛日";document.getElementById("roundId").value=item?.id||"";document.getElementById("roundPickDate").value=item?.pickDate||new Date().toISOString().slice(0,10);document.getElementById("roundBuyDate").value=item?.buyDate||"";document.getElementById("roundSellDate").value=item?.sellDate||"";document.getElementById("roundStatus").value=item?.status||"open";openModal("roundModal");
}
function saveRound(){const id=document.getElementById("roundId").value,pickDate=document.getElementById("roundPickDate").value,buyDate=document.getElementById("roundBuyDate").value,sellDate=document.getElementById("roundSellDate").value;if(!pickDate||!buyDate||!sellDate)return showToast("请填写三个日期");const current=state.rounds.find(r=>r.id===id);const item={...(current||{}),id:id||uid("round"),pickDate,buyDate,sellDate,status:document.getElementById("roundStatus").value,createdAt:current?.createdAt||nowISO(),updatedAt:nowISO()};if(current)Object.assign(current,item);else state.rounds.push(item);sharedRoundId=item.id;storageSet(SHARED_ROUND_KEY,sharedRoundId);closeModal("roundModal");markChanged("比赛日已保存");}
function deleteRound(id){const r=state.rounds.find(x=>x.id===id);if(!r||!confirm(`删除 ${fmtDate(r.pickDate)} 比赛日及全部选股？`))return;for(const pick of state.picks.filter(x=>x.roundId===id)){removeEntity("picks",pick.id);}removeEntity("rounds",id);if(sharedRoundId===id)sharedRoundId="";markChanged("比赛日已删除");}

function openPickModal(id=""){
  const round=getRound(sharedRoundId);if(!round)return showToast("请先新建比赛日");const item=state.picks.find(p=>p.id===id);document.getElementById("pickModalTitle").textContent=item?"编辑选股":"录入选股";document.getElementById("pickId").value=item?.id||"";document.getElementById("pickParticipant").innerHTML=activeParticipants().map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");document.getElementById("pickParticipant").value=item?.participantId||activeParticipants()[0]?.id||"";document.getElementById("pickCode").value=item?.stockCode||"";document.getElementById("pickName").value=item?.stockName||"";document.getElementById("pickSector").value=item?.sector||"";document.getElementById("pickReason").value=item?.reason||"";document.getElementById("pickBuyPrice").value=item?.buyPrice??"";document.getElementById("pickSellPrice").value=item?.sellPrice??"";document.getElementById("pickCurrentPrice").value=item?.currentPrice??"";document.getElementById("pickLookupStatus").innerHTML="";openModal("pickModal");
}
async function lookupPickCode(){const code=document.getElementById("pickCode").value.trim();if(!/^\d{6}$/.test(code))return showToast("请输入6位股票代码");const status=document.getElementById("pickLookupStatus");status.innerHTML='<span class="badge"><i class="spin">⟳</i> 查询中</span>';try{const payload=await apiJSON(`/api/quote?code=${encodeURIComponent(code)}`);const q=payload.data;document.getElementById("pickName").value=q.name||"";document.getElementById("pickSector").value=q.sector||"";document.getElementById("pickCurrentPrice").value=q.currentPrice??"";status.innerHTML=`<span class="badge success">${escapeHtml(q.provider)} · ${fmtPrice(q.currentPrice)}</span>`;}catch(error){status.innerHTML=`${errorButton(error.message)} <span class="muted">仍可手工填写</span>`;}}
function savePick(){const id=document.getElementById("pickId").value,participantId=document.getElementById("pickParticipant").value,stockCode=document.getElementById("pickCode").value.trim();if(!participantId||!/^\d{6}$/.test(stockCode))return showToast("请选择参赛者并填写6位代码");const existingForPerson=getPick(sharedRoundId,participantId);if(existingForPerson&&existingForPerson.id!==id)return showToast("该选手当前比赛日已有选股");if(state.settings.allowDuplicate===false&&state.picks.some(p=>p.roundId===sharedRoundId&&p.stockCode===stockCode&&p.id!==id))return showToast("当前规则不允许重复选股");const current=state.picks.find(p=>p.id===id);const item={...(current||{}),id:id||uid("pick"),roundId:sharedRoundId,participantId,stockCode,stockName:document.getElementById("pickName").value.trim(),sector:document.getElementById("pickSector").value.trim(),reason:document.getElementById("pickReason").value.trim(),buyPrice:numeric(document.getElementById("pickBuyPrice").value),sellPrice:numeric(document.getElementById("pickSellPrice").value),currentPrice:numeric(document.getElementById("pickCurrentPrice").value),createdAt:current?.createdAt||nowISO(),updatedAt:nowISO(),marketError:""};if(current)Object.assign(current,item);else state.picks.push(item);closeModal("pickModal");markChanged("选股已保存");}
function deletePick(id){const p=state.picks.find(x=>x.id===id);if(!p||!confirm(`删除 ${p.stockCode} ${p.stockName||""}？`))return;removeEntity("picks",id);technicalCache.delete(id);markChanged("选股已删除");}
function updatePickPrice(id,field,value){const p=state.picks.find(x=>x.id===id);if(!p)return;p[field]=numeric(value);p.updatedAt=nowISO();markChanged("价格已更新");}
function settleCurrentRound(){const round=getRound(sharedRoundId);if(!round)return;const missing=state.picks.filter(p=>p.roundId===round.id&&numeric(p.sellPrice)===null);if(missing.length)return showToast(`仍有 ${missing.length} 只股票缺少T+2开盘价`);round.status="settled";round.updatedAt=nowISO();markChanged("比赛日已正式结算");}

async function refreshPickQuote(id,showMessage=false){const pick=state.picks.find(p=>p.id===id);const round=getRound(pick?.roundId);if(!pick||!round)return;try{pick.marketError="";const [quoteResult,historyResult]=await Promise.allSettled([apiJSON(`/api/quote?code=${pick.stockCode}`),apiJSON(`/api/history?code=${pick.stockCode}&start=${round.buyDate}&end=${round.sellDate}&limit=20`)]);if(quoteResult.status==="fulfilled"){const q=quoteResult.value.data;pick.stockName=q.name||pick.stockName;pick.sector=q.sector||pick.sector;pick.currentPrice=numeric(q.currentPrice)??pick.currentPrice;pick.quoteTime=q.quoteTime||nowISO();pick.marketProvider=q.provider;}if(historyResult.status==="fulfilled"){const rows=historyResult.value.data.rows||[];const map=new Map(rows.map(r=>[r.date,numeric(r.open)]));if(numeric(pick.buyPrice)===null&&map.get(round.buyDate))pick.buyPrice=map.get(round.buyDate);if(numeric(pick.sellPrice)===null&&map.get(round.sellDate))pick.sellPrice=map.get(round.sellDate);}if(quoteResult.status==="rejected"&&historyResult.status==="rejected")throw new Error(`${quoteResult.reason.message}；${historyResult.reason.message}`);pick.updatedAt=nowISO();markChanged("行情已更新");if(showMessage)showToast("行情已更新");}catch(error){pick.marketError=error.message;pick.updatedAt=nowISO();markChanged("行情更新失败");if(showMessage)showToast("行情失败，请点击错误按钮查看");}}
async function refreshRoundQuotes(){const picks=state.picks.filter(p=>p.roundId===sharedRoundId);if(!picks.length)return showToast("当前比赛日暂无选股");showToast(`正在刷新 ${picks.length} 只股票`);for(let i=0;i<picks.length;i+=3)await Promise.all(picks.slice(i,i+3).map(p=>refreshPickQuote(p.id,false)));showToast("行情刷新完成");}
function avg(values){const clean=values.filter(Number.isFinite);return clean.length?clean.reduce((a,b)=>a+b,0)/clean.length:null;}
function sma(values,period){return values.length>=period?avg(values.slice(-period)):null;}
function emaSeries(values,period){if(!values.length)return[];const a=2/(period+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(values[i]*a+out[i-1]*(1-a));return out;}
function rsi(values,period=14){if(values.length<=period)return null;let gain=0,loss=0;for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>=0)gain+=d;else loss-=d;}let ag=gain/period,al=loss/period;for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}return al===0?100:100-100/(1+ag/al);}
function periodReturn(values,period){return values.length>period&&values.at(-1-period)?(values.at(-1)/values.at(-1-period)-1)*100:null;}
function std(values){const m=avg(values);return m===null?null:Math.sqrt(values.reduce((s,v)=>s+(v-m)**2,0)/values.length);}
function round(value,d=2){return Number.isFinite(Number(value))?Number(Number(value).toFixed(d)):null;}

function buildAnalysis(rows,benchmarkRows=[]){
  if(!Array.isArray(rows)||rows.length<30)throw new Error("有效日线不足30个交易日");
  const closes=rows.map(r=>Number(r.close)),volumes=rows.map(r=>Number(r.volume||0)),latest=rows.at(-1),previous=rows.at(-2),periods=[5,10,20,30,50,90,105,180];
  const mas=Object.fromEntries(periods.map(p=>[p,sma(closes,p)]));const ema12=emaSeries(closes,12),ema26=emaSeries(closes,26),dif=closes.map((_,i)=>ema12[i]-ema26[i]),dea=emaSeries(dif,9),macd=dif.map((v,i)=>(v-dea[i])*2);
  const rsi14=rsi(closes),r5=periodReturn(closes,5),r20=periodReturn(closes,20),r60=periodReturn(closes,60),deviation20=mas[20]?(latest.close/mas[20]-1)*100:null,volumeRatio=avg(volumes.slice(-6,-1))?volumes.at(-1)/avg(volumes.slice(-6,-1)):null;
  const benchCloses=benchmarkRows.map(r=>Number(r.close)).filter(Number.isFinite),bench20=periodReturn(benchCloses,20),relative20=r20!==null&&bench20!==null?r20-bench20:null;
  const daily=closes.slice(-21).map((v,i,a)=>i?(v/a[i-1]-1)*100:null).filter(Number.isFinite),volatility=std(daily);
  let raw=38;const breakdown=[];const add=(label,points)=>{if(Number.isFinite(points)&&Math.abs(points)>.01){raw+=points;breakdown.push({label,points:round(points,1)});}};const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  if(deviation20!==null)add("价格相对MA20",clamp(deviation20*.55,-8,6));let aligned=0,inverted=0;for(let i=0;i<periods.length-1;i++){if(!Number.isFinite(mas[periods[i]])||!Number.isFinite(mas[periods[i+1]]))continue;if(mas[periods[i]]>mas[periods[i+1]])aligned++;else inverted++;}add("均线排列",clamp((aligned-inverted)*1.6,-11.2,11.2));
  for(const [p,up,down] of [[50,4,-5],[90,4,-5],[180,5,-6]])if(Number.isFinite(mas[p]))add(`价格相对MA${p}`,latest.close>=mas[p]?up:down);
  const spread=latest.close?(dif.at(-1)-dea.at(-1))/latest.close*100:0;add("MACD",clamp(spread*20,-8,8));
  if(rsi14!==null){let pts=rsi14>=55&&rsi14<=68?7:rsi14>75?-clamp((rsi14-75)*1.2,2,12):rsi14<40?-clamp((40-rsi14)*.8+4,4,12):2;add("RSI14",pts);}
  if(r5!==null)add("近5日动量",clamp(r5*.7,-7,7));if(r20!==null)add("近20日动量",clamp(r20*.35,-9,9));if(r60!==null)add("近60日动量",clamp(r60*.12,-6,6));if(relative20!==null)add("相对上证",clamp(relative20*.45,-8,8));if(volumeRatio!==null)add("量价",latest.close>=previous.close&&volumeRatio>=1.05&&volumeRatio<=1.9?5:latest.close<previous.close&&volumeRatio>=1.5?-6:0);if(volatility!==null&&volatility>4)add("波动率",-clamp((volatility-4)*2,2,10));if(deviation20>12)add("均线偏离",deviation20>18?-10:-5);
  const score=Math.max(0,Math.min(120,Math.round(raw>100?100+(raw-100)*.4:raw)));const level=score>=108?"极强":score>=92?"强势":score>=76?"偏强":score>=58?"中性":score>=42?"偏弱":"弱势";
  const benchMap=new Map(benchmarkRows.map(r=>[r.date,Number(r.close)]));const chartRows=rows.slice(-180),baseStock=chartRows[0]?.close,baseBench=benchMap.get(chartRows[0]?.date);
  const chart=chartRows.map((row,index)=>{const absolute=rows.length-chartRows.length+index,item={date:row.date,close:round(row.close,3),dif:round(dif[absolute],4),dea:round(dea[absolute],4),macd:round(macd[absolute],4)};for(const p of periods)item[`ma${p}`]=absolute+1>=p?round(avg(closes.slice(absolute+1-p,absolute+1)),3):null;const b=benchMap.get(row.date);item.shIndex=Number.isFinite(b)?round(b,2):null;item.shScaled=Number.isFinite(b)&&baseBench&&baseStock?round(baseStock*b/baseBench,3):null;return item;});
  return {score,level,rawScore:round(raw,1),breakdown:breakdown.sort((a,b)=>Math.abs(b.points)-Math.abs(a.points)),dataDate:latest.date,close:round(latest.close,3),rsi14:round(rsi14),return5:round(r5),return20:round(r20),return60:round(r60),relative20:round(relative20),volumeRatio:round(volumeRatio),deviation20:round(deviation20),macd:round(macd.at(-1),4),dif:round(dif.at(-1),4),dea:round(dea.at(-1),4),mas:Object.fromEntries(periods.map(p=>[p,round(mas[p],3)])),chart};
}

async function analyzePick(id,openAfter=true,options={}){
  const pick=state.picks.find(p=>p.id===id),roundInfo=getRound(pick?.roundId),deferSave=options?.deferSave===true;if(!pick||!roundInfo)return false;
  try{
    if(openAfter){openModal("technicalModal");document.getElementById("technicalBody").innerHTML='<div class="empty"><i class="spin">⟳</i> 正在获取历史日线并计算…</div>';}
    const start=new Date(roundInfo.pickDate);start.setDate(start.getDate()-900);const startDate=start.toISOString().slice(0,10);
    const [stock,bench]=await Promise.all([apiJSON(`/api/history?code=${pick.stockCode}&start=${startDate}&end=${roundInfo.pickDate}&limit=420`),apiJSON(`/api/history?code=000001&market=sh&start=${startDate}&end=${roundInfo.pickDate}&limit=420`)]);
    const full=buildAnalysis(stock.data.rows,bench.data.rows);full.provider=stock.data.provider;full.benchmarkProvider=bench.data.provider;technicalCache.set(id,full);
    pick.analysisSummary={score:full.score,level:full.level,dataDate:full.dataDate,rsi14:full.rsi14,macd:full.macd,return5:full.return5,return20:full.return20,relative20:full.relative20,generatedAt:nowISO()};pick.technicalAnalysisError="";pick.updatedAt=nowISO();
    if(deferSave)saveLocal();else markChanged("技术分析已更新");if(openAfter)renderTechnicalModal(pick,full);return true;
  }catch(error){pick.technicalAnalysisError=`技术分析：${error.message}`;pick.updatedAt=nowISO();if(deferSave)saveLocal();else markChanged("技术分析失败");if(openAfter)document.getElementById("technicalBody").innerHTML=`<div class="notice online-warning">分析失败 ${errorButton(error.message)}</div>`;return false;}
}
async function analyzeAllPicks(){
  if(analysisBatchRunning)return;
  const round=getRound(sharedRoundId),picks=state.picks.filter(p=>p.roundId===sharedRoundId);if(!round)return showToast("请先选择比赛日");if(!picks.length)return showToast("当前比赛日暂无选股");
  analysisBatchRunning=true;const button=document.getElementById("analyzeAllBtn"),status=document.getElementById("analysisBatchStatus");if(button){button.disabled=true;button.textContent="分析中…";}
  let cursor=0,completed=0,success=0,failed=0;const update=()=>{if(status)status.textContent=`${completed}/${picks.length} · 成功 ${success} · 失败 ${failed}`;};update();
  try{
    const worker=async()=>{while(true){const index=cursor++;if(index>=picks.length)return;const ok=await analyzePick(picks[index].id,false,{deferSave:true});completed+=1;if(ok)success+=1;else failed+=1;update();}};
    await Promise.all(Array.from({length:Math.min(2,picks.length)},()=>worker()));analysisBatchRunning=false;markChanged(`批量分析完成：成功 ${success}，失败 ${failed}`);showToast(`分析全部完成：成功 ${success}，失败 ${failed}`);
  }finally{analysisBatchRunning=false;if(button){button.disabled=false;button.textContent="分析全部";}if(status)setTimeout(()=>{if(!analysisBatchRunning)status.textContent="";},4500);}
}
async function openTechnical(id){const pick=state.picks.find(p=>p.id===id);if(!pick)return;openModal("technicalModal");document.getElementById("technicalTitle").textContent=`${pick.stockCode} ${pick.stockName||""}｜技术分析`;const cached=technicalCache.get(id);if(cached)renderTechnicalModal(pick,cached);else await analyzePick(id,true);}
function toggleTechLayer(id,key){techLayers[key]=!techLayers[key];storageSet(TECH_LAYER_KEY,JSON.stringify(techLayers));const pick=state.picks.find(p=>p.id===id),full=technicalCache.get(id);if(pick&&full)renderTechnicalModal(pick,full);}
function renderTechnicalModal(pick,a){const body=document.getElementById("technicalBody");const defs={ma5:["MA5","#f59e0b"],ma10:["MA10","#10b981"],ma20:["MA20","#8b5cf6"],ma30:["MA30","#ec4899"],ma50:["MA50","#14b8a6"],ma90:["MA90","#6366f1"],ma105:["MA105","#a855f7"],ma180:["MA180","#64748b"],macd:["MACD","#0f766e"],shIndex:["上证指数","#dc2626"]};const controls=Object.entries(defs).map(([key,[label,color]])=>`<button class="curve-btn ${techLayers[key]?"active":""}" style="--c:${color}" onclick="toggleTechLayer('${pick.id}','${key}')"><i class="swatch"></i>${label}</button>`).join("");body.innerHTML=`<div class="grid grid-4"><div class="card stat"><div class="label">技术评分</div><div class="value">${a.score}/120</div><div class="sub">${a.level}</div></div><div class="card stat"><div class="label">RSI14</div><div class="value">${a.rsi14??"-"}</div><div class="sub">MACD ${a.macd??"-"}</div></div><div class="card stat"><div class="label">近20日</div><div class="value ${pctClass(a.return20)}">${fmtPct(a.return20)}</div><div class="sub">相对上证 ${fmtPct(a.relative20)}</div></div><div class="card stat"><div class="label">量比估算</div><div class="value">${a.volumeRatio??"-"}</div><div class="sub">数据至 ${fmtDate(a.dataDate)}</div></div></div><div style="margin-top:16px">${controls}</div><div id="technicalChartHost" style="margin-top:10px"></div><div class="card" style="margin-top:14px"><div class="section-title"><h3>主要评分项</h3><button class="btn btn-small" onclick="analyzePick('${pick.id}',true)">重新分析</button></div><div class="actions">${a.breakdown.slice(0,14).map(x=>`<span class="badge ${x.points>=0?"success":"danger"}">${escapeHtml(x.label)} ${x.points>=0?"+":""}${x.points.toFixed(1)}</span>`).join("")}</div><p class="muted" style="font-size:11px">个股：${escapeHtml(a.provider||"-")}；指数：${escapeHtml(a.benchmarkProvider||"-")}</p></div>`;renderTechChart(pick,a,defs);}
function renderTechChart(pick,a,defs){
  const points=a.chart||[];const host=document.getElementById("technicalChartHost");if(points.length<2){host.innerHTML='<div class="empty">暂无图表数据</div>';return;}
  const width=840,mainH=300,macdH=techLayers.macd?130:0,gap=techLayers.macd?22:0,height=mainH+macdH+gap,pad=48,plotW=width-pad-18,top=18,bottom=mainH-30;
  const series=[{key:"close",label:"收盘价",color:"#2563eb",w:2.8}];for(const key of Object.keys(defs)){if(!techLayers[key]||key==="macd")continue;if(key==="shIndex")series.push({key:"shScaled",label:"上证指数",color:defs[key][1],w:2,dash:"7 5"});else series.push({key,label:defs[key][0],color:defs[key][1],w:1.8});}
  const vals=series.flatMap(s=>points.map(p=>Number(p[s.key]))).filter(Number.isFinite);let min=Math.min(...vals),max=Math.max(...vals);if(min===max){min-=1;max+=1;}const margin=(max-min)*.08;min-=margin;max+=margin;const span=max-min,x=i=>pad+i/(points.length-1)*plotW,y=v=>bottom-(v-min)/span*(bottom-top);
  const grids=Array.from({length:5},(_,i)=>{const yy=top+i/4*(bottom-top),v=max-i/4*span;return`<line x1="${pad}" y1="${yy}" x2="${width-18}" y2="${yy}" stroke="#e4e8f0"/><text x="${pad-6}" y="${yy+3}" text-anchor="end" font-size="10" fill="#98a2b3">${fmtPrice(v)}</text>`;}).join("");
  const lines=series.map(s=>{let d="";points.forEach((p,i)=>{const v=Number(p[s.key]);if(Number.isFinite(v))d+=`${d?"L":"M"}${x(i)},${y(v)} `;});return`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w}" ${s.dash?`stroke-dasharray="${s.dash}"`:""} stroke-linecap="round" stroke-linejoin="round"/>`;}).join("");
  let macd="",macdCfg=null;if(techLayers.macd){const mt=mainH+gap,mb=height-22,mvals=points.flatMap(p=>[p.macd,p.dif,p.dea]).filter(Number.isFinite),abs=Math.max(.001,...mvals.map(Math.abs)),my=v=>mt+(abs-v)/(abs*2)*(mb-mt),zero=my(0),barW=Math.max(1,Math.min(4,plotW/points.length*.65));const bars=points.map((p,i)=>Number.isFinite(Number(p.macd))?`<rect x="${x(i)-barW/2}" y="${Math.min(zero,my(p.macd))}" width="${barW}" height="${Math.max(1,Math.abs(my(p.macd)-zero))}" fill="${p.macd>=0?"#ef4444":"#10b981"}" opacity=".65"/>`:"").join("");const line=key=>{const d=points.map((p,i)=>Number.isFinite(Number(p[key]))?`${i?"L":"M"}${x(i)},${my(p[key])}`:"").join(" ");return`<path d="${d}" fill="none" stroke="${key==="dif"?"#2563eb":"#f59e0b"}" stroke-width="1.7"/>`;};macd=`<text x="${pad}" y="${mt-6}" font-size="11" font-weight="800" fill="#475467">MACD</text><line x1="${pad}" y1="${zero}" x2="${width-18}" y2="${zero}" stroke="#98a2b3" stroke-dasharray="4 4"/>${bars}${line("dif")}${line("dea")}`;macdCfg={mt,mb,abs,my};}
  const labels=[0,Math.floor((points.length-1)/2),points.length-1].map(i=>`<text x="${x(i)}" y="${mainH-8}" text-anchor="${i===0?"start":i===points.length-1?"end":"middle"}" font-size="10" fill="#667085">${points[i].date.slice(5)}</text>`).join("");
  host.innerHTML=`<div class="chart-box" id="techChartBox"><svg id="techChartSvg" viewBox="0 0 ${width} ${height}">${grids}${lines}${labels}${macd}<rect id="techHit" x="${pad}" y="${top}" width="${plotW}" height="${height-top-18}" fill="transparent" style="cursor:crosshair"/><g id="techCursor" style="display:none;pointer-events:none"><line id="techCursorLine" x1="0" x2="0" y1="${top}" y2="${height-18}" stroke="#667085" stroke-dasharray="4 4"/><g id="techMarkers"></g></g></svg><div class="chart-tooltip" id="techTooltip"></div></div>`;
  const svg=document.getElementById("techChartSvg"),box=document.getElementById("techChartBox"),hit=document.getElementById("techHit"),cursor=document.getElementById("techCursor"),cursorLine=document.getElementById("techCursorLine"),markers=document.getElementById("techMarkers"),tooltip=document.getElementById("techTooltip");
  hit.addEventListener("pointermove",event=>{const rect=svg.getBoundingClientRect(),vx=(event.clientX-rect.left)/rect.width*width,index=Math.max(0,Math.min(points.length-1,Math.round((vx-pad)/plotW*(points.length-1)))),p=points[index],cx=x(index);cursor.style.display="";cursorLine.setAttribute("x1",cx);cursorLine.setAttribute("x2",cx);const dots=[];for(const s of series){const v=Number(p[s.key]);if(Number.isFinite(v))dots.push(`<circle cx="${cx}" cy="${y(v)}" r="4" fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`);}if(macdCfg){for(const [key,color] of [["dif","#2563eb"],["dea","#f59e0b"]])if(Number.isFinite(Number(p[key])))dots.push(`<circle cx="${cx}" cy="${macdCfg.my(p[key])}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1.4"/>`);}markers.innerHTML=dots.join("");const rows=[];for(const s of series){if(s.key==="shScaled"){if(Number.isFinite(Number(p.shIndex)))rows.push([s.color,"上证指数",Number(p.shIndex).toFixed(2)]);}else if(Number.isFinite(Number(p[s.key])))rows.push([s.color,s.label,Number(p[s.key]).toFixed(3)]);}if(macdCfg){for(const [key,label,color] of [["dif","DIF","#2563eb"],["dea","DEA","#f59e0b"],["macd","MACD",Number(p.macd)>=0?"#ef4444":"#10b981"]])if(Number.isFinite(Number(p[key])))rows.push([color,label,Number(p[key]).toFixed(4)]);}tooltip.innerHTML=`<div class="tooltip-date">${p.date}</div>${rows.map(([c,l,v])=>`<div class="tooltip-row"><i class="tooltip-dot" style="background:${c}"></i><span>${l}</span><strong>${v}</strong></div>`).join("")}`;tooltip.classList.add("show");const br=box.getBoundingClientRect();let left=event.clientX-br.left+12;if(left+tooltip.offsetWidth>box.clientWidth-8)left=event.clientX-br.left-tooltip.offsetWidth-12;let tt=event.clientY-br.top-tooltip.offsetHeight/2;tt=Math.max(8,Math.min(tt,box.clientHeight-tooltip.offsetHeight-8));tooltip.style.left=`${Math.max(8,left)}px`;tooltip.style.top=`${tt}px`;});
  hit.addEventListener("pointerleave",()=>{cursor.style.display="none";tooltip.classList.remove("show");});
}

function saveSettings(){state.settings.competitionName=document.getElementById("settingName").value.trim()||"每日选股擂台";state.settings.unsubmittedReturn=Number(document.getElementById("settingUnsubmitted").value||0);state.settings.allowDuplicate=document.getElementById("settingDuplicate").value==="true";state.settings.ruleNote=document.getElementById("settingRule").value.trim();state.meta.settingsUpdatedAt=nowISO();markChanged("设置已保存");}
function csvDownload(filename,rows){const text="\ufeff"+rows.map(row=>row.map(value=>`"${String(value??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");downloadBlob(filename,new Blob([text],{type:"text/csv;charset=utf-8"}));}
function downloadBlob(filename,blob){const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function exportDailyCSV(){const round=getRound(sharedRoundId);if(!round)return;const rows=[["名次","选手","股票代码","股票名称","收益率%","积分","状态"],...dailyRows(round.id).map(r=>[r.rank,r.participant.name,r.pick?.stockCode||"",r.pick?.stockName||"",r.returnPct??"",r.points,r.isTemporary?"临时":r.isMissing?"待价格":r.isUnsubmitted?"未提交":"正式"] )];csvDownload(`每日排名_${round.pickDate}.csv`,rows);}
function exportTotalCSV(){const rows=[["总排名","选手","累计收益率%","总积分","正式比赛日","冠军次数"],...totalRows().map(r=>[r.rank,r.participant.name,r.compoundReturn,r.points,r.days,r.wins])];csvDownload("总排行榜.csv",rows);}
function exportJSON(){downloadBlob(`股票比赛共享备份_${new Date().toISOString().slice(0,10)}.json`,new Blob([JSON.stringify(state,null,2)],{type:"application/json"}));}
async function importJSON(file){if(!file)return;try{const parsed=normalizeState(JSON.parse(await file.text()));if(!confirm("导入会覆盖并合并当前共享数据，是否继续？"))return;state=mergeStates(parsed,state);markChanged("备份已导入");}catch(error){showToast(`导入失败：${error.message}`);}}
function resetSharedData(){if(!confirm("确定清空全部在线共享数据？此操作会影响所有访问者。"))return;if(!confirm("再次确认：参赛者、比赛日和选股记录都将清空。"))return;state=defaultState();state.meta.settingsUpdatedAt=nowISO();dirty=true;saveLocal();renderAll();saveRemote();}

function errorButton(message){return message?`<button class="error-btn" data-error="${escapeHtml(message)}" onclick="showError(event,this)">错误！</button>`:"";}
function showError(event,button){event?.stopPropagation();const pop=document.getElementById("errorPopover"),body=document.getElementById("errorPopoverBody");body.textContent=button.dataset.error||"未知错误";pop.classList.add("show");requestAnimationFrame(()=>{const r=button.getBoundingClientRect(),pr=pop.getBoundingClientRect();let left=Math.max(12,Math.min(r.right-pr.width,innerWidth-pr.width-12)),top=r.bottom+7;if(top+pr.height>innerHeight-12)top=r.top-pr.height-7;pop.style.left=`${left}px`;pop.style.top=`${Math.max(12,top)}px`;});}
function closeErrorPopover(){document.getElementById("errorPopover").classList.remove("show");}

Object.assign(window,{showPage,setSharedRound,openParticipantModal,saveParticipant,deleteParticipant,openRoundModal,saveRound,deleteRound,openPickModal,lookupPickCode,savePick,deletePick,updatePickPrice,settleCurrentRound,refreshPickQuote,refreshRoundQuotes,openTechnical,analyzePick,analyzeAllPicks,toggleTechLayer,closeModal,saveSettings,exportDailyCSV,exportTotalCSV,exportJSON,importJSON,resetSharedData,showError,closeErrorPopover});

document.getElementById("nav").addEventListener("click",event=>{const button=event.target.closest("button[data-page]");if(button)showPage(button.dataset.page);});
document.getElementById("menuBtn").addEventListener("click",()=>document.getElementById("sidebar").classList.toggle("show"));
document.getElementById("syncNowBtn").addEventListener("click",()=>dirty?saveRemote():loadRemote({forceApply:true}));
document.getElementById("visitorName").value=visitorName;document.getElementById("visitorName").addEventListener("change",event=>{visitorName=event.target.value.trim()||`访客-${clientId().slice(-4).toUpperCase()}`;event.target.value=visitorName;storageSet(CLIENT_NAME_KEY,visitorName);});
document.addEventListener("click",event=>{if(document.getElementById("errorPopover").classList.contains("show")&&!event.target.closest("#errorPopover")&&!event.target.closest(".error-btn"))closeErrorPopover();});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){document.querySelectorAll(".modal-backdrop.show").forEach(el=>closeModal(el.id));closeErrorPopover();}});document.addEventListener("focusout",()=>setTimeout(applyPendingRemote,80));

renderAll();loadRemote({initial:true}).finally(()=>startRealtime());pollTimer=setInterval(pollRemote,15000);window.addEventListener("beforeunload",()=>{saveLocal();if(realtimeChannel&&supabase)supabase.removeChannel(realtimeChannel);});
