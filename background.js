import { safeUrl, validSamples } from './core.mjs';
let queue = Promise.resolve();
const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
const state = async () => (await chrome.storage.session.get('guard')).guard;
async function badge(text) { await chrome.action.setBadgeText({text}); await chrome.action.setBadgeBackgroundColor({color:'#137e74'}); }
async function openPanel() {
  const url = chrome.runtime.getURL('monitor.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === url);
  if (existing) { await chrome.tabs.update(existing.id,{active:true}); await chrome.windows.update(existing.windowId,{focused:true}); }
  else await chrome.tabs.create({url,pinned:true});
}
chrome.action.onClicked.addListener(openPanel);
async function protect(reason) {
  const s = await state();
  if (!s?.enabled) return;
  // Latch before tab operations to prevent repeated triggers and races.
  await chrome.storage.session.set({guard:{...s, enabled:false, reason, triggeredAt:Date.now()}});
  await badge('!');
  const tabs = await chrome.tabs.query({active:true,windowId:s.windowId});
  const target = tabs[0];
  const canClose = target && target.id !== s.monitorId && target.id !== s.protectionTabId && /^https?:\/\//.test(target.url || '');
  let entry;
  if (canClose) {
    entry = {id:crypto.randomUUID(),url:target.url,title:target.title || target.url,time:Date.now(),reason,closed:false};
    const {history=[]} = await chrome.storage.local.get('history');
    await chrome.storage.local.set({history:[entry,...history].slice(0,200)});
  }
  try {
    if (canClose) {
      await chrome.tabs.remove(target.id);
      const {history=[]} = await chrome.storage.local.get('history');
      await chrome.storage.local.set({history:history.map(h=>h.id===entry.id?{...h,closed:true}:h)});
    }
    // Activate the original tab without updating its URL or reloading its document.
    if (!s.protectionTabId) throw new Error('保护标签页未记录，请重新开启保护');
    const protectionTab = await chrome.tabs.update(s.protectionTabId,{active:true});
    await chrome.windows.update(protectionTab.windowId,{focused:true});
  } catch (e) {
    await chrome.storage.session.set({guard:{...s,enabled:false,reason:`保护操作失败：${e.message}；${entry?'原网址已记录；':''}请检查预先打开的保护标签页并重新开启保护`,triggeredAt:Date.now()}});
  }
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('monitor.html')) return;
  serial(async()=>{
    const s = await state();
    if(m.type==='start') {
      const url=safeUrl(m.url);
      const {samples=[]}=await chrome.storage.local.get('samples');
      if(!validSamples(samples)) throw new Error('请使用新模型完成五种角度的录入');
      if(s?.enabled) throw new Error('保护已在运行');
      let tab;
      if(s?.url===url && s.protectionTabId) {
        try { tab=await chrome.tabs.get(s.protectionTabId); } catch { /* Previously closed tab: create only when starting protection. */ }
        if(tab && tab.windowId!==sender.tab.windowId) tab=undefined;
      }
      if(tab) { await chrome.tabs.update(tab.id,{active:true}); await chrome.windows.update(tab.windowId,{focused:true}); }
      else tab=await chrome.tabs.create({url,windowId:sender.tab.windowId,active:true});
      await chrome.storage.session.set({guard:{enabled:true,url,protectionTabId:tab.id,windowId:tab.windowId,monitorId:sender.tab.id,heartbeat:Date.now()}});
      await chrome.alarms.create('watchdog',{periodInMinutes:0.5});
      await badge('ON');
    } else if(m.type==='stop') {
      await chrome.storage.session.set({guard:{...s,enabled:false,reason:'已手动停止'}}); await badge('');
    } else if(m.type==='heartbeat' && s?.enabled && s.monitorId===sender.tab.id) {
      await chrome.storage.session.set({guard:{...s,heartbeat:Date.now()}});
    } else if(m.type==='protect' && s?.monitorId===sender.tab.id) await protect(m.reason);
    return {ok:true};
  }).then(reply,e=>reply({ok:false,error:e.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(id=>serial(async()=>{if((await state())?.monitorId===id) await protect('监测页面被关闭');}));
chrome.alarms.onAlarm.addListener(()=>serial(async()=>{const s=await state();if(s?.enabled && Date.now()-s.heartbeat>15000) await protect('摄像头监测失去响应');}));
chrome.runtime.onStartup.addListener(()=>badge(''));
