"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname,"../web/admin.js"),"utf8");
const html = fs.readFileSync(path.join(__dirname,"../web/admin.html"),"utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const tick = () => new Promise(setImmediate);
async function settle() { for (let i=0;i<5;i++) await tick(); }
const report = {ok:true,summary:{total_rows:2,valid_rows:2,invalid_rows:0,duplicate_rows:0},file_errors:[],row_errors:[],warnings:[],contract_confirmed:true};
function environment(options={}) {
  const elements = new Map(), calls = [], actions = [];
  function element() {
    return {value:"",textContent:"",disabled:false,hidden:false,checked:false,files:[],children:[],events:{},
      append(child){this.children.push(child);},replaceChildren(){this.children=[];this.value="";},classList:{toggle(){}},
      addEventListener(name,fn){this.events[name]=fn;},
      checkValidity(){return !this.max || this.value <= this.max;}};
  }
  for (const id of ids) elements.set(id,element());
  const get = id => { assert(elements.has(id),`Missing real HTML element: ${id}`); return elements.get(id); };
  let configuration;
  let tokenAttempt = 0;
  const storage = options.storage || new Map();
  const TestDate=options.now ? class extends Date {constructor(...args){super(...(args.length ? args : [options.now]));}} : Date;
  const context = {Intl,Date:TestDate,URL,URLSearchParams,AbortController,
    FormData:class {constructor(){this.values=new Map();} append(k,v){this.values.set(k,v);}},
    document:{getElementById:get,createElement:element,title:"Admin"},
    window:{location:{origin:"http://127.0.0.1:8000",href:"http://127.0.0.1:8000/admin.html"+(options.search||""),search:options.search||""},
      sessionStorage:{
        getItem(key){if(options.storageBlocked)throw Error("Storage blocked");return storage.get(key)||null;},
        setItem(key,value){if(options.storageBlocked)throw Error("Storage blocked");storage.set(key,value);},
        removeItem(key){storage.delete(key);},
      },
      history:{replaceState(...args){actions.push(["replaceState",args]);}},addEventListener(){},
      auth0: options.noSdk ? undefined : {Auth0Client:class {
        constructor(config){configuration=config;}
        async checkSession(){throw Error("checkSession must not gate reload restoration");}
        async isAuthenticated(){return false;}
        async getTokenSilently(){
          actions.push("token");tokenAttempt++;
          if(options.tokenError || tokenAttempt <= (options.failTokenAttempts||0)) throw options.authError || Error("secret-token");
          return "secret-token";
        }
        async getUser(){return options.userPromise ? options.userPromise : {email:"admin@example.test"};}
        async handleRedirectCallback(){actions.push("callback");if(options.callbackError)throw options.authError || Error("private callback details");}
        async loginWithRedirect(settings){
          if(settings && settings.authorizationParams && settings.authorizationParams.prompt === "none") actions.push(["silent-redirect",settings]);
          else actions.push("login");
        }
        async logout(){actions.push("logout");if(options.logoutError)throw Error("private error");}
      }}},
    async fetch(url,settings){
      calls.push({url,settings});
      if(url==="/api/admin/me" && options.mePromise) await options.mePromise;
      if(url==="/api/admin/uploads" && !settings.method && options.historyPromise) await options.historyPromise;
      assert.equal(settings.headers.Authorization,"Bearer secret-token");
      assert.equal(settings.redirect,"error");assert.equal(settings.cache,"no-store");
      if(options.networkError)throw Error("secret-token");
      if(url==="/api/admin/uploads" && !settings.method && options.historyError)throw Error("secret-token");
      let status=200,body;
      if(url==="/api/admin/me") {status=options.code||200;body={sub:"auth0|admin",permissions:options.readOnly?["read:admin"]:["read:admin","import:calls"]};}
      else if(url==="/api/admin/uploads" && !settings.method) {status=options.historyCode||200;body=options.history||[];}
      else if(url==="/api/admin/validate") body=options.invalid ? {...report,ok:false,row_errors:[{row_number:2,errors:[{message:"Invalid timestamp"}]}]} : report;
      else if(url==="/api/admin/uploads") {
        status=options.uploadCode||201;
        const validation=options.validationReport || (options.invalid ? {...report,ok:false,row_errors:[{row_number:2,errors:[{message:"Invalid timestamp"}]}]} : report);
        body={id:options.batchId||"new-batch",status:options.batchStatus||(validation.ok ? "validated" : "invalid"),validation:{...validation,contract_confirmed:!options.unconfirmed}};
      }
      else if(url.endsWith("/import")) {
        if(options.conflict && !JSON.parse(settings.body).replace_batch_id){status=409;body={detail:"This month is already imported."};}
        else body={id:"new-batch",status:"imported"};
      } else throw Error(`Unexpected route ${url}`);
      return {ok:status<300,status,async json(){return JSON.parse(JSON.stringify(body));}};
    },console:{log(){throw Error("Unexpected token logging");},error(){throw Error("Unexpected logging");}}
  };
  vm.runInNewContext(source,context);
  async function event(id,type="click") { const node=get(id); if(type==="click" && node.disabled)return; await node.events[type]({preventDefault(){}}); await settle(); }
  async function choose(file={name:"calls.xlsx",size:100}){get("workbook").files=Array.isArray(file)?file:[file];await event("workbook","change");}
  function noSecrets(){for(const node of elements.values())assert(!node.textContent.includes("secret-token"));}
  return {get,calls,actions,event,choose,noSecrets,config:()=>configuration};
}
(async()=>{
  let count=0;
  for(const code of [200,401,403,503]) {
    const e=environment({code});await settle();assert.equal(e.get("adminContent").hidden,code!==200);e.noSecrets();
    assert.equal(e.get("logout").hidden,code!==200);
    assert.equal(e.get("userEmail").hidden,code!==200);
    if(code===401) {
      assert.equal(e.get("authStatus").textContent,"The admin API rejected the access token (401). Log in again to continue.");
      assert(!e.get("authStatus").textContent.includes("invalid_token"));
    }
    assert.equal(e.config().cacheLocation,"memory");assert.equal(e.config().useRefreshTokens,false);count++;
  }
  for(const options of [{tokenError:true},{networkError:true},{noSdk:true},{search:"?error=access_denied&state=test",callbackError:true}]) {
    const e=environment(options);await settle();assert(e.get("adminContent").hidden);assert(e.get("logout").hidden);assert(e.get("userEmail").hidden);assert(!e.actions.includes("login"));e.noSecrets();count++;
  }
  const restored=environment();await settle();assert(!restored.get("adminContent").hidden);assert.equal(restored.calls[0].url,"/api/admin/me");count++;
  const callback=environment({search:"?code=test&state=test"});await settle();assert(callback.actions.includes("callback"));assert(callback.actions.some(a=>Array.isArray(a)&&a[0]==="replaceState"));assert(!callback.get("logout").hidden);assert(!callback.get("userEmail").hidden);count++;
  for(const code of [200,401]) {
    let finishMe;const mePromise=new Promise(resolve=>{finishMe=resolve;});
    const pending=environment({code,mePromise});await settle();
    assert(pending.actions.includes("token"));assert(pending.calls.some(c=>c.url==="/api/admin/me"));
    assert(pending.get("logout").hidden);assert(pending.get("userEmail").hidden);assert(pending.get("adminContent").hidden);
    finishMe();await settle();assert.equal(pending.get("logout").hidden,code!==200);assert.equal(pending.get("userEmail").hidden,code!==200);count++;
  }
  const rejectedCallback=environment({search:"?code=test&state=test",code:401});await settle();
  assert(rejectedCallback.get("logout").hidden);assert(rejectedCallback.get("userEmail").hidden);assert(rejectedCallback.get("adminContent").hidden);count++;
  const revokedOptions={},revoked=environment(revokedOptions);await settle();assert(!revoked.get("logout").hidden);
  revokedOptions.historyCode=401;await revoked.event("refreshHistory");
  assert(revoked.get("logout").hidden);assert(revoked.get("userEmail").hidden);assert(revoked.get("adminContent").hidden);
  assert(revoked.get("authStatus").textContent.includes("admin API rejected"));count++;
  const failed=environment({tokenError:true,authError:{error:"consent_required"}});await settle();await failed.event("login");assert(failed.actions.includes("login"));count++;
  const e=environment();await settle();assert(e.get("uploadMonth").value<=e.get("uploadMonth").max);
  for(const file of [{name:"bad.csv",size:100},{name:"empty.xlsx",size:0},{name:"big.xlsx",size:26*1024*1024},[]]) {await e.choose(file);assert(e.get("checkFile").disabled);}
  await e.choose();await e.event("checkFile");assert.equal(e.get("validationState").textContent,"Passed");assert.equal(e.get("validationCounts").textContent,"2 / 0 / 0");
  assert.equal(e.calls.filter(c=>c.url==="/api/admin/uploads"&&c.settings.method==="POST").length,1);
  assert(!e.calls.some(c=>c.url==="/api/admin/validate"));assert(e.get("importFile").disabled);
  const upload=e.calls.find(c=>c.url==="/api/admin/uploads"&&c.settings.method==="POST");
  assert.equal(upload.settings.body.values.get("month"),e.get("uploadMonth").value);
  assert.equal(upload.settings.body.values.get("file").name,"calls.xlsx");
  assert(!("Content-Type" in upload.settings.headers));
  assert.equal(e.get("uploadStatus").textContent,"Validated batch");
  e.get("expectedRows").value="3";e.get("confirmImport").checked=true;await e.event("expectedRows","input");assert(e.get("importFile").disabled);
  e.get("expectedRows").value="2";await e.event("expectedRows","input");assert(!e.get("importFile").disabled);
  await e.event("importFile");assert(e.get("importStatus").textContent.includes("Import completed"));
  assert.deepEqual(JSON.parse(e.calls.find(c=>c.url.endsWith("/import")).settings.body),{expected_rows:2});assert(e.get("importFile").disabled);count++;
  const invalid=environment({invalid:true});await settle();await invalid.choose();await invalid.event("checkFile");assert(invalid.get("importFile").disabled);assert.equal(invalid.get("validationIssues").children[0].textContent,"Row 2: Invalid timestamp");assert.equal(invalid.get("uploadStatus").textContent,"Validation failed");count++;
  const unconfirmed=environment({unconfirmed:true});await settle();await unconfirmed.choose();await unconfirmed.event("checkFile");unconfirmed.get("expectedRows").value="2";unconfirmed.get("confirmImport").checked=true;await unconfirmed.event("expectedRows","input");assert(unconfirmed.get("importFile").disabled);count++;
  const read=environment({readOnly:true});await settle();await read.choose();assert(read.get("checkFile").disabled);await read.event("stageFile");assert(read.get("importFile").disabled);assert(!read.get("adminContent").hidden);assert(read.calls.some(c=>c.url==="/api/admin/validate"));assert(!read.calls.some(c=>c.url==="/api/admin/uploads"&&c.settings.method));count++;
  const replacement=environment({conflict:true});await settle();replacement.get("uploadMonth").value="2026-09";
  // Supply an imported history row for the selected reporting month.
  const r=environment({conflict:true,history:[{id:"old-batch",month:"2026-09-01",status:"imported",uploader:"<script>alert(1)</script>"}]});await settle();
  r.get("uploadMonth").value="2026-09";await r.event("uploadMonth","input");await r.choose();await r.event("checkFile");
  r.get("expectedRows").value="2";r.get("confirmImport").checked=true;await r.event("expectedRows","input");await r.event("importFile");
  assert(r.get("importStatus").textContent.includes("already imported"));assert(!r.get("confirmImport").checked);
  assert(!r.get("replaceCurrentBatch").hidden);await r.event("replaceCurrentBatch");assert.equal(r.get("replaceBatch").value,"old-batch");assert(!r.get("confirmImport").checked);
  assert(r.get("replaceCurrentBatch").hidden);
  assert.equal(r.get("importFile").textContent,"Replace Current Batch");
  r.get("confirmImport").checked=true;await r.event("confirmImport","input");await r.event("importFile");
  assert.equal(JSON.parse(r.calls.filter(c=>c.url.endsWith("/import")).at(-1).settings.body).replace_batch_id,"old-batch");
  assert.equal(r.get("historyRows").children[0].children[2].textContent,"<script>alert(1)</script>");count++;
  await e.event("logout");assert(e.get("adminContent").hidden);assert(e.actions.includes("logout"));assert.equal(e.get("workbook").value,"");count++;
  const logoutOptions={logoutError:true},failedLogout=environment(logoutOptions);await settle();
  await failedLogout.event("logout");
  assert(!failedLogout.get("logout").hidden);assert(!failedLogout.get("logout").disabled);
  assert(failedLogout.get("adminContent").hidden);assert(failedLogout.get("userEmail").hidden);
  assert(failedLogout.get("authStatus").textContent.includes("Sign-out could not complete"));
  logoutOptions.logoutError=false;await failedLogout.event("logout");
  assert.equal(failedLogout.actions.filter(action=>action==="logout").length,2);
  assert(failedLogout.get("adminContent").hidden);assert(failedLogout.get("logout").hidden);count++;
  let finishUser;const userPromise=new Promise(resolve=>{finishUser=resolve;});
  const race=environment({userPromise});await settle();await race.event("logout");finishUser({email:"late@example.test"});await settle();assert(race.get("adminContent").hidden);count++;
  const reportUi=environment();await settle();reportUi.get("reportMonth").value="2026-09";await reportUi.event("reportMonth","input");assert.equal(reportUi.get("reportMonthLabel").textContent,"2026-09");assert(reportUi.get("reportStatus").textContent.includes("unavailable"));count++;
  const recovered=environment({failTokenAttempts:1,authError:{error:"timeout",error_description:"secret-token"}});
  await settle();assert(!recovered.get("adminContent").hidden);assert.equal(recovered.actions.filter(a=>a==="token").length,3);count++;
  const timeoutOptions={tokenError:true,authError:{error:"timeout",error_description:"secret-token"}};
  const timeout=environment(timeoutOptions);await settle();assert(timeout.get("adminContent").hidden);
  assert.equal(timeout.actions.filter(a=>a==="token").length,2);assert.equal(timeout.calls.length,0);
  assert(!timeout.get("retrySession").hidden);assert(timeout.get("login").hidden);
  assert(timeout.get("authStatus").textContent.includes("timeout"));timeout.noSecrets();
  timeoutOptions.tokenError=false;await timeout.event("retrySession");assert(!timeout.get("adminContent").hidden);count++;
  for(const options of [{code:503},{networkError:true}]) {
    const unavailable=environment(options);await settle();assert(unavailable.get("adminContent").hidden);
    assert(!unavailable.get("retrySession").hidden);assert(unavailable.get("login").hidden);
    assert(unavailable.get("authStatus").textContent.includes("admin API"));count++;
  }
  const guard=new Map(), loginRequired={tokenError:true,authError:{error:"login_required",error_description:"secret-token"},storage:guard};
  const silent=environment(loginRequired);await settle();assert(silent.get("adminContent").hidden);
  assert.equal(silent.actions.filter(a=>Array.isArray(a)&&a[0]==="silent-redirect").length,1);
  assert.equal(guard.get("v4w.admin.silent-recovery"),"attempted");silent.noSecrets();
  const repeated=environment(loginRequired);await settle();assert(!repeated.actions.some(a=>Array.isArray(a)&&a[0]==="silent-redirect"));
  await repeated.event("login");assert(repeated.actions.includes("login"));assert.equal(guard.size,0);count++;
  const failedCallback=environment({search:"?error=login_required&state=test",callbackError:true,authError:{error:"login_required"}});
  await settle();assert(failedCallback.get("adminContent").hidden);assert(!failedCallback.actions.some(a=>Array.isArray(a)&&a[0]==="silent-redirect"));
  assert(!failedCallback.get("login").hidden);count++;
  const noStorage=environment({tokenError:true,authError:{error:"login_required"},storageBlocked:true});await settle();
  assert(noStorage.get("adminContent").hidden);assert(!noStorage.actions.some(a=>Array.isArray(a)&&a[0]==="silent-redirect"));count++;
  const mutationOptions={};const mutation=environment(mutationOptions);await settle();await mutation.choose();await mutation.event("checkFile");
  mutation.get("expectedRows").value="2";mutation.get("confirmImport").checked=true;await mutation.event("expectedRows","input");
  mutationOptions.tokenError=true;mutationOptions.authError={error:"network_error"};await mutation.event("importFile");
  assert(mutation.get("adminContent").hidden);assert.equal(mutation.calls.filter(c=>c.url.endsWith("/import")).length,0);count++;
  const uncertainOptions={};const uncertain=environment(uncertainOptions);await settle();await uncertain.choose();await uncertain.event("checkFile");
  uncertain.get("expectedRows").value="2";uncertain.get("confirmImport").checked=true;await uncertain.event("expectedRows","input");
  uncertainOptions.networkError=true;await uncertain.event("importFile");
  assert.equal(uncertain.calls.filter(c=>c.url.endsWith("/import")).length,1);assert(!uncertain.get("confirmImport").checked);count++;
  for(const [now,expected] of [["2027-01-15T12:00:00Z","2026-12"],["2026-11-01T01:00:00Z","2026-09"]]) {
    const calendar=environment({now});await settle();
    assert.equal(calendar.get("uploadMonth").value,expected);assert.equal(calendar.get("uploadMonth").max,expected);
    assert.equal(calendar.get("reportMonth").max,expected);await calendar.choose();
    calendar.get("uploadMonth").value="2027-02";await calendar.event("uploadMonth","input");
    assert(calendar.get("checkFile").disabled);assert(calendar.get("stageFile").disabled);count++;
  }
  const backendSource=fs.readFileSync(path.join(__dirname,"../db/pipeline.py"),"utf8");
  const backendMegabytes=Number(backendSource.match(/^MAX_BYTES = (\d+) \* 1024 \* 1024/m)[1]);
  const limit=environment();await settle();
  await limit.choose({name:"boundary.xlsx",size:backendMegabytes*1024*1024});assert(!limit.get("checkFile").disabled);
  await limit.choose({name:"too-large.xlsx",size:backendMegabytes*1024*1024+1});assert(limit.get("checkFile").disabled);count++;
  const detailedReport={...report,ok:false,summary:{total_rows:250,valid_rows:20,invalid_rows:225,duplicate_rows:5},
    file_errors:[{message:"Synthetic file-level issue"}],
    row_errors:Array.from({length:201},(_,i)=>({row_number:i+2,errors:[{message:"First issue"},{message:"Second issue"}]})),
    row_errors_truncated:true,days_without_calls:[2,7],warnings:["Synthetic completeness warning","<img src=x onerror=alert(1)>"]};
  const detailed=environment({validationReport:detailedReport});await settle();await detailed.choose();await detailed.event("checkFile");
  assert.equal(detailed.get("validationCounts").textContent,"20 / 225 / 5");
  const issues=detailed.get("validationIssues").children.map(li=>li.textContent);
  assert.equal(issues.filter(text=>text.startsWith("Row ")).length,200);
  assert(issues.includes("Synthetic file-level issue"));assert(issues.includes("Only the first 200 row errors are shown."));
  assert(issues.includes("Days without calls: 2, 7. Verify completeness."));assert(issues.includes("Synthetic completeness warning"));
  assert(issues.includes("<img src=x onerror=alert(1)>"));assert(detailed.get("importFile").disabled);count++;
  const truncated=environment({validationReport:{...detailedReport,row_errors:detailedReport.row_errors.slice(0,200)}});
  await settle();await truncated.choose();await truncated.event("checkFile");
  assert(truncated.get("validationIssues").children.some(li=>li.textContent==="Only the first 200 row errors are shown."));count++;
  for(const status of ["invalid","imported","expired","superseded"]) {
    const stopped=environment({batchStatus:status});await settle();await stopped.choose();await stopped.event("checkFile");
    stopped.get("expectedRows").value="2";stopped.get("confirmImport").checked=true;await stopped.event("expectedRows","input");
    assert(stopped.get("importFile").disabled);await stopped.event("importFile");
    assert(!stopped.calls.some(c=>c.url.endsWith("/import")));count++;
  }
  const saved=environment({batchId:"00000000-0000-0000-0000-000000000123"});await settle();await saved.choose();await saved.event("checkFile");
  saved.get("expectedRows").value="2";saved.get("confirmImport").checked=true;await saved.event("confirmImport","input");
  assert(!saved.get("importFile").disabled);assert.equal(saved.get("importFile").textContent,"Validate & Import");await saved.event("importFile");
  assert.equal(saved.calls.find(c=>c.url.endsWith("/import")).url,"/api/admin/uploads/00000000-0000-0000-0000-000000000123/import");
  assert.equal(saved.get("uploadStatus").textContent,"Imported");count++;
  const changed=environment();await settle();await changed.choose();await changed.event("checkFile");
  changed.get("expectedRows").value="2";changed.get("confirmImport").checked=true;await changed.event("confirmImport","input");
  await changed.choose({name:"another.xlsx",size:100});assert(changed.get("importFile").disabled);assert(!changed.get("confirmImport").checked);
  assert.equal(changed.get("validationState").textContent,"Not run");assert.equal(changed.get("expectedRows").value,"");count++;
  const failedUpload=environment({uploadCode:503});await settle();await failedUpload.choose();await failedUpload.event("checkFile");
  assert.equal(failedUpload.get("uploadStatus").textContent,"Validation unavailable");assert(failedUpload.get("importFile").disabled);count++;
  for(const signedOutOptions of [
    {tokenError:true,authError:{error:"login_required"},storageBlocked:true},
    {tokenError:true,authError:{error:"login_required"}},
    {search:"?error=login_required&state=test",callbackError:true,authError:{error:"login_required"}},
  ]) {
    const signedOut=environment(signedOutOptions);await settle();
    assert.equal(signedOut.get("authStatus").textContent,"Sign in to continue.");
    assert(signedOut.get("adminContent").hidden);assert(signedOut.get("logout").hidden);
    assert(!signedOut.get("login").hidden);assert(!signedOut.get("login").disabled);
    assert.equal(signedOut.calls.length,0);assert(!signedOut.actions.includes("login"));signedOut.noSecrets();count++;
  }
  let finishHistory;const historyPromise=new Promise(resolve=>{finishHistory=resolve;});
  const historyOptions={now:"2026-11-02T18:00:00Z",historyPromise,
    history:[{id:"history-batch",month:"2026-10-01",status:"validated",uploader:"synthetic"}]};
  const refreshed=environment(historyOptions);await settle();
  assert.equal(refreshed.get("historyStatus").textContent,"Loading upload history...");
  assert.equal(refreshed.get("refreshHistory").textContent,"Refreshing...");assert(refreshed.get("refreshHistory").disabled);
  assert(!refreshed.get("historyRefreshedAt").textContent.startsWith("Last refreshed:"));
  finishHistory();await settle();
  assert.equal(refreshed.get("historyStatus").textContent,"1 uploads shown.");
  assert(refreshed.get("historyRefreshedAt").textContent.startsWith("Last refreshed:"));
  assert(!refreshed.get("refreshHistory").disabled);count++;
  const firstRefreshTime=refreshed.get("historyRefreshedAt").textContent;
  let finishAgain;historyOptions.historyPromise=new Promise(resolve=>{finishAgain=resolve;});
  historyOptions.now="2026-11-02T18:01:00Z";
  // Same data with reordered object properties must still report no changes.
  historyOptions.history=[{uploader:"synthetic",status:"validated",month:"2026-10-01",id:"history-batch"}];
  const refreshAction=refreshed.event("refreshHistory");await settle();
  assert(refreshed.get("refreshHistory").disabled);assert.equal(refreshed.get("historyStatus").textContent,"Loading upload history...");
  assert.equal(refreshed.get("historyRefreshedAt").textContent,firstRefreshTime);
  finishAgain();await refreshAction;
  assert.equal(refreshed.get("historyStatus").textContent,"No changes. 1 uploads shown.");
  assert.notEqual(refreshed.get("historyRefreshedAt").textContent,firstRefreshTime);count++;
  historyOptions.history=[{id:"history-batch",month:"2026-10-01",status:"imported",uploader:"synthetic"}];
  await refreshed.event("refreshHistory");
  assert(!refreshed.get("historyStatus").textContent.startsWith("No changes."));
  assert.equal(refreshed.get("historyRows").children[0].children[1].textContent,"imported");count++;
  const successfulRefreshTime=refreshed.get("historyRefreshedAt").textContent;
  historyOptions.now="2026-11-02T18:02:00Z";historyOptions.historyError=true;
  await refreshed.event("refreshHistory");
  assert(refreshed.get("historyStatus").textContent.includes("could not complete"));
  assert.equal(refreshed.get("historyRefreshedAt").textContent,successfulRefreshTime);
  assert.equal(refreshed.get("historyRows").children[0].children[1].textContent,"imported");
  assert(!refreshed.get("refreshHistory").disabled);refreshed.noSecrets();count++;
  const emptyHistory=environment();await settle();await emptyHistory.event("refreshHistory");
  assert.equal(emptyHistory.get("historyStatus").textContent,"No changes. No uploads yet.");count++;
  let finishLateHistory;const lateHistoryPromise=new Promise(resolve=>{finishLateHistory=resolve;});
  const historyLogout=environment({historyPromise:lateHistoryPromise});await settle();await historyLogout.event("logout");
  finishLateHistory();await settle();
  assert(historyLogout.get("adminContent").hidden);assert.equal(historyLogout.get("historyRefreshedAt").textContent,"Not refreshed yet.");
  assert.equal(historyLogout.get("historyRows").children.length,0);count++;
  console.log(`Admin checks passed (${count} scenarios).`);
})().catch(error=>{console.error(error);process.exitCode=1;});
