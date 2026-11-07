import {POSES, MODEL_ID, classify, cosine, safeUrl} from './core.mjs';
import {FaceEngine} from './face-engine.mjs';
const engine=new FaceEngine();
const $=id=>document.getElementById(id);
let stream,ready=false, samples=[],roi={x:0,y:0,w:1,h:1},enabled=false,enrolling=false, strangerAt=null,absentAt=null,lastFrame=-1,staleAt=Date.now();
const crop=document.createElement('canvas');
const msg=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error||'后台未响应');return r;};
const status=t=>$('status').textContent=t;
const report=e=>status(e.message||String(e));
async function settings(){ await chrome.storage.local.set({settings:{url:$('url').value,roi,strangerDelay:Number($('strangerDelay').value),absenceDelay:Number($('absenceDelay').value)}}); }
function poses(){ $('poses').replaceChildren(...POSES.map((p,i)=>{const el=document.createElement('div');const n=samples.filter(s=>s.pose===p).length;el.className=`pose ${n>=3?'done':i===nextPose()?'current':''}`;el.textContent=`${p} ${n}/3`;return el;})); }
function nextPose(){return POSES.findIndex(p=>samples.filter(s=>s.pose===p).length<3);}
function controls(){ $('enroll').disabled=!ready||enabled||enrolling||nextPose()<0;$('start').disabled=!ready||enabled||enrolling||nextPose()>=0;for(const id of ['clear','camera','devices','resetRoi','url','strangerDelay','absenceDelay'])$(id).disabled=enabled||enrolling; }
async function refresh(){const {guard}=await chrome.storage.session.get('guard');enabled=!!guard?.enabled;$('badge').textContent=enabled?'保护中':guard?.triggeredAt?'已触发保护':'未开启'; if(!enabled&&guard?.triggeredAt)status(guard.reason+'。保护已暂停，可从下方恢复网址。');controls();}
async function fail(reason){await msg('protect',{reason});await refresh();}
async function camera(){
 if(enabled||enrolling)return;
 ready=false;controls();stream?.getTracks().forEach(t=>t.stop());
 try{
 status('正在加载本地模型与摄像头…');
 const device=$('devices').value;
 stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},...(device?{deviceId:{exact:device}}:{})},audio:false});
 $('video').srcObject=stream;await $('video').play();
 stream.getVideoTracks()[0].onended=()=>{ready=false;controls();if(enabled)fail('摄像头已断开').catch(report);};
 const devices=await navigator.mediaDevices.enumerateDevices();$('devices').replaceChildren(...devices.filter(d=>d.kind==='videoinput').map((d,i)=>new Option(d.label||`摄像头 ${i+1}`,d.deviceId)));$('devices').value=stream.getVideoTracks()[0].getSettings().deviceId;
 await engine.load();
 $('placeholder').hidden=true;ready=true;staleAt=Date.now();lastFrame=-1;status('摄像头已就绪。请录入五种角度，或开启保护。');draw();
 }catch(e){stream?.getTracks().forEach(t=>t.stop());report(e);}controls();
}
function draw(faces=[]){const c=$('overlay'),v=$('video');c.width=v.videoWidth||640;c.height=v.videoHeight||480;const ctx=c.getContext('2d');ctx.fillStyle='#071f1b88';ctx.fillRect(0,0,c.width,c.height);ctx.clearRect(roi.x*c.width,roi.y*c.height,roi.w*c.width,roi.h*c.height);ctx.strokeStyle='#74e7ad';ctx.lineWidth=3;ctx.strokeRect(roi.x*c.width,roi.y*c.height,roi.w*c.width,roi.h*c.height);for(const f of faces){const b=f.detection.box;ctx.strokeStyle='#f1ca71';ctx.strokeRect(roi.x*c.width+b.x,roi.y*c.height+b.y,b.width,b.height);}$('roiLabel').textContent=`检测范围：X ${Math.round(roi.x*100)}% / Y ${Math.round(roi.y*100)}% / 宽 ${Math.round(roi.w*100)}% / 高 ${Math.round(roi.h*100)}%`;}
let detectionQueue=Promise.resolve();
function detect(){const task=detectionQueue.then(async()=>{const v=$('video');crop.width=Math.max(1,Math.round(v.videoWidth*roi.w));crop.height=Math.max(1,Math.round(v.videoHeight*roi.h));crop.getContext('2d').drawImage(v,roi.x*v.videoWidth,roi.y*v.videoHeight,crop.width,crop.height,0,0,crop.width,crop.height);return engine.detect(crop);});detectionQueue=task.catch(()=>{});return task;}
async function loop(){try{
 if(ready&&!enrolling){
 const v=$('video');if(v.currentTime!==lastFrame){lastFrame=v.currentTime;staleAt=Date.now();}else if(enabled&&Date.now()-staleAt>5000){await fail('摄像头画面已冻结');return;}
 const faces=await detect();draw(faces);
 if(enabled){
 const r=classify(faces.map(f=>f.descriptor),samples);const now=Date.now();
 strangerAt=r.stranger?(strangerAt??now):null;absentAt=r.absent?(absentAt??now):null;
 status(`检测到 ${faces.length} 张脸 · 匹配分 ${r.scores.map(s=>s.toFixed(1)).join(' / ')||'无'} · 原始余弦 ${r.cosines.map(c=>c.toFixed(3)).join(' / ')||'无'} · ${r.stranger?'陌生人或无法验证':r.absent?'未检测到使用者':'使用者在场'} · ${Math.round(engine.lastMs)}ms ${faces.map(f=>f.quality).filter(Boolean).join('；')}`);
 if(strangerAt!==null&&now-strangerAt>=Number($('strangerDelay').value))await fail('检测到陌生人（相似度低于 70）');
 else if(absentAt!==null&&now-absentAt>=Number($('absenceDelay').value))await fail('使用者离开检测范围');
 else await msg('heartbeat');
 }else status(`预览：${faces.length} 张脸 · ${faces.map(f=>f.quality||'可录入').join(' / ')||'未检测到人脸，请调整光线或角度'} · ${Math.round(engine.lastMs)}ms`);
 }
 }catch(e){report(e);if(enabled)await fail('人脸检测异常：'+e.message).catch(report);}
 finally{setTimeout(loop,350);}}
$('camera').onclick=camera;$('devices').onchange=camera;
$('enroll').onclick=async()=>{const pose=POSES[nextPose()];enrolling=true;controls();try{
 const batch=[],deadline=Date.now()+20000;let hint='请保持范围内仅有本人';
 while(batch.length<3&&Date.now()<deadline){status(`录入${pose} ${batch.length}/3 · ${hint}`);await new Promise(r=>setTimeout(r,450));const faces=await detect();draw(faces);
 if(faces.length!==1){hint='请确保范围内恰好有一张人脸，正在等待清晰帧';continue;}
 const f=faces[0];if(!f.descriptor){hint=f.quality;continue;}
 const descriptor=f.descriptor;
 // Enrollment may include a larger pose change than normal verification.
 if(samples.length&&Math.max(...samples.map(s=>cosine(descriptor,s.descriptor)))<.25){hint='与已录入身份差异过大，请缓慢转头';continue;}
 if(batch.length&&cosine(descriptor,batch[0].descriptor)<.45){hint='姿态变化过快，请保持当前姿态';continue;}
 batch.push({pose,descriptor,model:MODEL_ID});hint='清晰帧已采集，请保持姿态';}
 if(batch.length<3)throw new Error(`录入未完成：${hint}。本轮未保存，请重试。`);
 samples.push(...batch);await chrome.storage.local.set({samples});poses();status(nextPose()<0?'五种角度录入完成，可以开启保护。':`录入成功，接下来录入${POSES[nextPose()]}。`);
 }catch(e){report(e);}finally{enrolling=false;controls();}};
$('clear').onclick=async()=>{if(enabled||enrolling)return;samples=[];await chrome.storage.local.remove('samples');poses();controls();status('已删除所有面部特征。');};
$('start').onclick=async()=>{try{safeUrl($('url').value);const faces=await detect();if(faces.length!==1||classify(faces.map(f=>f.descriptor),samples).absent)throw new Error('开启前需要确认仅有使用者本人在场，且面部清晰');await settings();await msg('start',{url:$('url').value});strangerAt=null;absentAt=null;staleAt=Date.now();await refresh();}catch(e){report(e);}};
$('stop').onclick=async()=>{try{await msg('stop');await refresh();status('保护已停止。');}catch(e){report(e);}};
let origin;
function point(e){const b=$('overlay').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};}
$('overlay').onpointerdown=e=>{if(enabled||enrolling||!ready)return;origin=point(e);$('overlay').setPointerCapture(e.pointerId);};
$('overlay').onpointerup=async e=>{if(!origin)return;const p=point(e),w=Math.abs(p.x-origin.x),h=Math.abs(p.y-origin.y);if(w>=.15&&h>=.15){roi={x:Math.min(p.x,origin.x),y:Math.min(p.y,origin.y),w,h};await settings();draw();}origin=null;};
$('resetRoi').onclick=async()=>{roi={x:0,y:0,w:1,h:1};await settings();draw();};
for(const id of ['url','strangerDelay','absenceDelay'])$(id).onchange=()=>settings().catch(report);
async function history(){const {history=[]}=await chrome.storage.local.get('history');$('history').replaceChildren();if(!history.length){$('history').textContent='暂无关闭记录';return;}for(const h of history){const row=document.createElement('div');row.className='history-item';const box=document.createElement('div'),a=document.createElement('a'),s=document.createElement('small'),button=document.createElement('button');a.textContent=h.title;a.href=safeUrl(h.url);a.target='_blank';a.rel='noreferrer';s.textContent=`${new Date(h.time).toLocaleString('zh-CN')} · ${h.reason} · ${h.closed?'已关闭':'已记录，未确认关闭'} · ${h.url}`;button.textContent='恢复网页';button.onclick=()=>chrome.tabs.create({url:safeUrl(h.url)});box.append(a,s);row.append(box,button);$('history').append(row);}}
$('clearHistory').onclick=async()=>{await chrome.storage.local.remove('history');await history();};
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.guard)refresh().catch(report);if(changes.history)history().catch(report);});
const stored=await chrome.storage.local.get(['samples','settings']);samples=(stored.samples||[]).filter(s=>s.model===MODEL_ID);if(samples.length!==(stored.samples||[]).length){await chrome.storage.local.set({samples});status('已升级人脸模型，旧特征不兼容，请重新录入五种角度。');}if(stored.settings){roi=stored.settings.roi||roi;$('url').value=stored.settings.url||'';$('strangerDelay').value=String(stored.settings.strangerDelay??600);$('absenceDelay').value=String(stored.settings.absenceDelay??1500);}poses();await refresh();if(enabled)await fail('监测页面已刷新，摄像头监测中断');await history();loop();
