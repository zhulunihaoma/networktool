import { randomUUID } from "node:crypto";
import path from "node:path";
import { AI_PLATFORMS } from "../../src/shared/platforms";
import type {
  AIPlatform,
  PlatformResult,
  PlatformScan,
  ProcessInfo,
  Evidence,
  PlatformProgress,
  PlatformPath,
} from "../../src/shared/types";

export function detectRunningApps(
  platform: AIPlatform,
  processes: ProcessInfo[],
) {
  return [
    ...new Set(
      processes
        .filter((process) => {
          const name = path.win32
            .basename(path.basename(process.name))
            .replace(/\.exe$/i, "")
            .toLowerCase();
          return platform.processNames.some(
            (alias) =>
              name === alias.toLowerCase() ||
              name.startsWith(`${alias.toLowerCase()} helper`) ||
              name.startsWith(`${alias.toLowerCase()} helper (`),
          );
        })
        .map((process) => process.name),
    ),
  ];
}
export function classifyPlatform(platformId:string,evidence:Evidence[],route:string,httpStatus?:number):PlatformResult {
  const paths:PlatformPath[]=[];
  const system=evidence.filter(e=>e.source==="Chromium · system network");
  const browser=system.find(e=>e.stage==="http"&&e.status==="failed");
  const response=system.find(e=>e.stage==="http"&&e.status==="success"&&e.httpStatus);
  const valid=(n?:number)=>n!==undefined&&n>=200&&n<=599;
  const status=httpStatus??response?.httpStatus;
  const pathStatus=(n:number)=>n===403||n===451?"restricted" as const:"accessible" as const;
  const systemTls=system.some(e=>e.stage==="tls"&&e.status==="success");
  if(system.length||httpStatus!==undefined)paths.push({label:"系统路径",status:valid(status)?pathStatus(status!):systemTls?"network_reachable":"unreachable",httpStatus:valid(status)?status:undefined,code:browser?.code});
  const groups=new Map<string,Evidence[]>();
  for(const e of evidence.filter(e=>e.source!=="Chromium · system network"&&["tcp","proxy","tls","http"].includes(e.stage))){
    const label=e.route==="direct"?`直连${e.family===4?"（IPv4）":e.family===6?"（IPv6）":""}`:"代理路径";
    groups.set(label,[...(groups.get(label)||[]),e]);
  }
  for(const [label,items] of groups){
    const replies=items.filter(e=>e.stage==="http"&&e.status==="success"&&valid(e.httpStatus));
    const reply=replies.find(e=>pathStatus(e.httpStatus!)==="accessible")||replies[0];
    const failure=items.find(e=>e.status==="failed");
    const tlsConnected=items.some(e=>e.stage==="tls"&&e.status==="success");
    paths.push({label,status:reply?pathStatus(reply.httpStatus!):tlsConnected?"network_reachable":failure?"unreachable":"not_run",httpStatus:reply?.httpStatus,code:failure?.code});
  }
  const result:PlatformResult={platformId,status:"check_failed",summary:"检测未完成：未能确定能否访问",suggestion:"请重新测试；此次检测执行没有完成，不能据此判断网络可达或不可达。",route,evidence,runningApps:[],checkedAt:Date.now(),paths,progress:{label:"结果已生成",completed:5,total:5}};
  const applyHttp=(n:number)=>{
    result.httpStatus=n;
    if(n===401){result.status="auth_required";result.summary="网络可达，平台要求登录";result.suggestion="在平台中登录后再试。检查不读取你的登录状态，也不能判断账号是否失效。";}
    else if(n===403||n===451){result.status="restricted";result.summary="网络可达，但平台拒绝访问";result.suggestion="在浏览器查看是否需要验证码或存在地区、企业网络访问限制；仍被拒绝时请联系 IT。";}
    else if(n===429||n>=500){result.status="busy";result.summary=n===429?"网络可达，平台限制请求频率":"网络可达，平台返回服务异常";result.suggestion="稍后再试，并查看平台公告；这不能证明平台全球故障。";}
    else{result.status="reachable";result.summary=n>=300&&n<400?"网络可达，平台返回跳转响应":n>=400?`网络可达，入口返回 HTTP ${n}`:"平台入口可访问";result.suggestion=n>=400?"平台已响应，网络能够连到入口。当前只读检查请求未获正常页面，请在浏览器打开平台；不把此情况当作断网。":"如仍不能聊天或上传，请在工具中确认登录和权限。入口可访问不验证 AI 对话和文件上传。";}
  };
  if(valid(status)){applyHttp(status!);return result;}
  // A fallback is a definite result for its own path, never proof that the failed system path works.
  const fallback=paths.find(p=>p.label!=="系统路径"&&p.status==="accessible")||paths.find(p=>p.label!=="系统路径"&&valid(p.httpStatus));
  if(fallback){
    applyHttp(fallback.httpStatus!);result.route=fallback.label;
    result.summary=`${fallback.label}${result.status==="reachable"?"可访问":result.status==="auth_required"?"可连接，需登录":result.status==="restricted"?"可连接，访问被拒绝":"可连接，服务响应异常"}；系统路径${browser?.code?.includes("TIMED_OUT")?"访问超时":"访问失败"}`;
    result.suggestion="当前系统访问没有成功，已明确列出可连接的补充路径。请在浏览器复测，并让 IT 核对实际使用的网络路径。";
    return result;
  }
  if(!browser)return result;
  result.status="network_error";
  const error=browser.code||"";
  if(/NAME_NOT_RESOLVED/.test(error)){result.summary="访问失败：无法解析平台地址";result.suggestion="确认其他网页能否打开，再重新连接网络；请 IT 检查域名解析。";}
  else if(/CERT_|SSL_/.test(error)){result.summary="访问失败：安全连接校验失败";result.suggestion="检查电脑时间；如需公司证书，请联系 IT，勿关闭证书验证。";}
  else if(/PROXY_|TUNNEL_/.test(error)){result.summary="访问失败：当前代理连接失败";result.suggestion="确认公司批准的网络工具运行正常，再请 IT 核对代理配置。";}
  else{result.summary=error.includes("TIMED_OUT")?"访问失败：本次连接超时":"访问失败：未收到平台入口响应";result.suggestion="检查网络后重新测试。如果只有该平台失败，请把各条路径的检查结果发给 IT。";}
  if(evidence.some(e=>e.stage==="tls"&&e.status==="success"))result.summary="访问失败：安全连接已建立，但入口没有有效响应";
  return result;
}

interface Dependencies {
  processes():Promise<ProcessInfo[]>;
  probe(platform:AIPlatform,signal:AbortSignal,progress:(value:PlatformProgress)=>void):Promise<PlatformResult>;
}
const pending=(platformId:string):PlatformResult=>({platformId,status:"pending",summary:"尚未测试",suggestion:"",route:"系统网络",evidence:[],runningApps:[],progress:{label:"排队等待",completed:0,total:5}});
interface Batch {abort:AbortController;queue:AIPlatform[];}
export class PlatformDoctor {
  private scan:PlatformScan={id:"initial",status:"idle",results:AI_PLATFORMS.map(p=>pending(p.id))};
  private batch?:Batch;
  private lastStarted=new Map<string,number>();
  constructor(private dependencies:Dependencies,private publish:(scan:PlatformScan)=>void){}
  current(){return structuredClone(this.scan);}
  start(id?:string){
    const platform=id?AI_PLATFORMS.find(p=>p.id===id):undefined;
    if(id&&!platform)throw new Error("不支持的平台。");
    const now=Date.now();
    if(this.scan.status==="running"&&this.batch){
      if(!platform)return this.current();
      const row=this.scan.results.find(r=>r.platformId===id)!;
      if(row.status==="checking")return this.current();
      const index=this.batch.queue.findIndex(p=>p.id===id);
      if(index>=0){this.batch.queue.splice(index,1);this.batch.queue.unshift(platform);row.summary="已优先安排单服务测试";this.emit();return this.current();}
      this.checkFrequency(platform.id,now);
      this.lastStarted.set(platform.id,now);
      this.batch.queue.unshift(platform);
      this.scan.platformIds=[...new Set([...(this.scan.platformIds||[]),platform.id])];
      this.reset(platform.id);this.emit();return this.current();
    }
    const requested=AI_PLATFORMS.filter(p=>!id||p.id===id);
    const selected=requested.filter(p=>now-(this.lastStarted.get(p.id)||0)>=30000);
    if(!selected.length)throw new Error("刚刚已测试过，请等待 30 秒后再试。");
    const batch:Batch={abort:new AbortController(),queue:[...selected]};this.batch=batch;
    this.scan={...this.scan,id:randomUUID(),status:"running",started:now,ended:undefined,detectionError:undefined,platformIds:selected.map(p=>p.id)};
    selected.forEach(p=>{this.lastStarted.set(p.id,now);this.reset(p.id);});
    this.emit();void this.run(batch,selected.length);return this.current();
  }
  private checkFrequency(id:string,now:number){if(now-(this.lastStarted.get(id)||0)<30000)throw new Error("刚刚已测试过，请等待 30 秒后再试。");}
  private reset(id:string){this.scan.results=this.scan.results.map(r=>r.platformId===id?{...pending(id),runningApps:r.runningApps}:r);}
  stop(){
    if(this.scan.status!=="running")return this.current();
    this.batch?.abort.abort();if(this.batch)this.batch.queue=[];
    this.scan.status="cancelled";this.scan.ended=Date.now();
    this.scan.results=this.scan.results.map(r=>(this.scan.platformIds||[]).includes(r.platformId)&&["pending","checking"].includes(r.status)?{...r,status:"cancelled",summary:"本次测试已停止",suggestion:"可以稍后重新测试。",progress:{label:"已停止",completed:r.progress?.completed||0,total:5}}:r);
    this.emit();return this.current();
  }
  private emit(){this.publish(this.current());}
  private async run(batch:Batch,initialCount:number){
    let processes:ProcessInfo[]=[];
    try{processes=await this.dependencies.processes();}catch{if(!batch.abort.signal.aborted)this.scan.detectionError="无法读取运行中的应用；平台入口测试仍可继续。";}
    if(batch.abort.signal.aborted)return;
    this.scan.results=this.scan.results.map(r=>({...r,runningApps:detectRunningApps(AI_PLATFORMS.find(p=>p.id===r.platformId)!,processes)}));this.emit();
    const worker=async()=>{
      while(batch.queue.length&&!batch.abort.signal.aborted){
        const platform=batch.queue.shift()!,started=Date.now();
        const row=this.scan.results.find(r=>r.platformId===platform.id)!;
        row.status="checking";row.summary="正在测试平台入口";row.progress={label:"连接平台入口",completed:0,total:5,startedAt:started};this.emit();
        let result:PlatformResult;
        try{result=await this.dependencies.probe(platform,batch.abort.signal,value=>{
          if(batch.abort.signal.aborted)return;
          const current=this.scan.results.find(r=>r.platformId===platform.id)!;
          current.progress=value;current.summary=value.label;this.emit();
        });}catch{result={...pending(platform.id),status:"check_failed",summary:"检测执行失败，请重新测试",suggestion:"此次检测没有完成，不将执行错误判定为网络不可达。",checkedAt:Date.now()};}
        if(batch.abort.signal.aborted)return;
        result.runningApps=row.runningApps;result.duration=Date.now()-started;result.progress={label:"测试完成",completed:5,total:5,startedAt:started};
        this.scan.results=this.scan.results.map(r=>r.platformId===platform.id?result:r);this.emit();
      }
    };
    await Promise.all(Array.from({length:Math.min(4,initialCount)},worker));
    if(batch.abort.signal.aborted)return;
    this.scan.status="completed";this.scan.ended=Date.now();this.emit();
  }
}
