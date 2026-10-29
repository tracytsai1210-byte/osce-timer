/* ============================================================
   OSCE 考站計時器 V02 — app.js
   計時核心以 performance.now() 時間戳校正，不依賴 setInterval 累加。
   所有資料僅存於瀏覽器 localStorage；請只使用「學員 A」「第 3 站」等模擬資料。
   ============================================================ */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const KEY='osce-timer-v2';
  const DEFAULT_STATIONS=[
    {name:'第 1 站',task:'病史詢問'},
    {name:'第 2 站',task:'心肺聽診'},
    {name:'第 3 站',task:'腹部身體檢查'},
    {name:'第 4 站',task:'傷口縫合'}
  ];
  const PHASE={read:'閱題',exam:'測驗',done:'時間到'};
  const RING_LEN=2*Math.PI*150;   // r=150 之圓周

  let stations=JSON.parse(JSON.stringify(DEFAULT_STATIONS));
  let cfg={read:60,exam:480,warn:60,sound:true,voice:false,repeat:true,student:'學員 A'};
  let log=[];
  let cur=2;                 // 目前站別索引
  let phase='exam';          // read | exam
  let running=false, remainMs=0, lastTick=0, raf=null, warned=false, over=false, overStart=0, alarmTimer=null, examStartedAt=null;

  /* ---------- 儲存 ---------- */
  function load(){
    try{
      const s=JSON.parse(localStorage.getItem(KEY)||'null');
      if(!s)return;
      Object.assign(cfg,s.cfg||{});
      if(Array.isArray(s.stations)&&s.stations.length)stations=s.stations;
      if(Array.isArray(s.log))log=s.log;
      if(typeof s.cur==='number')cur=Math.min(s.cur,stations.length-1);
    }catch(e){}
  }
  function save(){try{localStorage.setItem(KEY,JSON.stringify({cfg,stations,log,cur}));}catch(e){}}

  function readCfg(){
    const n=(id,lo,hi,d)=>Math.min(hi,Math.max(lo,parseInt($(id).value,10)||d));
    cfg.read=n('cfgRead',0,900,60);
    cfg.exam=n('cfgMin',1,60,8)*60;
    cfg.warn=n('cfgWarn',0,600,60);
    cfg.sound=$('cfgSound').checked;cfg.voice=$('cfgVoice').checked;cfg.repeat=$('cfgRepeat').checked;
    cfg.student=$('cfgStudent').value.trim()||'學員 A';
    writeCfg();save();
  }
  function writeCfg(){
    $('cfgRead').value=cfg.read;$('cfgMin').value=Math.round(cfg.exam/60);$('cfgWarn').value=cfg.warn;
    $('cfgSound').checked=cfg.sound;$('cfgVoice').checked=cfg.voice;$('cfgRepeat').checked=cfg.repeat;$('cfgStudent').value=cfg.student;
    document.querySelectorAll('.preset').forEach(b=>b.classList.toggle('on',+b.dataset.min*60===cfg.exam));
  }

  /* ---------- 聲音／震動／語音 ---------- */
  let ctx=null;
  function beep(pattern){
    if(!cfg.sound)return;
    try{
      ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
      if(ctx.state==='suspended')ctx.resume();
      let t=ctx.currentTime;
      pattern.forEach(([f,d])=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.type='sine';o.frequency.value=f;
        g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.6,t+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+d);
        o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+d+0.05);t+=d+0.1;
      });
    }catch(e){}
  }
  function vibrate(p){try{if(navigator.vibrate)navigator.vibrate(p);}catch(e){}}
  function speak(text){
    if(!cfg.voice)return;
    try{const u=new SpeechSynthesisUtterance(text);u.lang='zh-TW';u.rate=1;speechSynthesis.cancel();speechSynthesis.speak(u);}catch(e){}
  }
  function startAlarm(){
    stopAlarm();
    const ring=()=>{beep([[1046,0.25],[1046,0.25],[1046,0.5]]);vibrate([400,150,400,150,600]);};
    ring();
    if(cfg.repeat)alarmTimer=setInterval(ring,2500);
  }
  function stopAlarm(){if(alarmTimer){clearInterval(alarmTimer);alarmTimer=null;}}

  /* ---------- 工具 ---------- */
  const fmt=s=>{s=Math.max(0,Math.ceil(s));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let toastT=null;
  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2200);}
  function nowStr(){const d=new Date();return d.toTimeString().slice(0,5);}

  /* ---------- 畫面 ---------- */
  function render(){
    const st=stations[cur];
    const total=phase==='read'?cfg.read:cfg.exam;
    const clock=$('clock');
    $('stName').textContent=st.name;$('stTask').textContent=st.task||'（未填任務）';
    $('student').textContent=cfg.student;
    $('roundNo').textContent=log.filter(r=>r.station===st.name).length+1;
    $('markExam').textContent=fmt(cfg.exam);$('markWarn').textContent=cfg.warn?fmt(cfg.warn):'—';$('markRead').textContent=cfg.read?fmt(cfg.read):'無';
    clock.dataset.phase=phase;
    clock.classList.toggle('idle',!running&&!over);

    if(over){
      const o=(performance.now()-overStart)/1000;
      $('phaseLabel').textContent=PHASE.done;
      $('time').textContent='00:00';$('subTime').textContent='已超時 +'+fmt(o);
      setRing(1);
      clock.classList.add('over');clock.classList.remove('warning','paused');
      $('btnStart').textContent=alarmTimer?'停止鈴聲':'已結束';
    }else{
      const remain=remainMs/1000;
      $('phaseLabel').textContent=PHASE[phase];
      $('time').textContent=fmt(remain);
      $('subTime').textContent=phase==='read'?('接著測驗 '+fmt(cfg.exam)):(running?'已進行 '+fmt(total-remain):(remain<total?'已暫停':'就緒'));
      setRing(1-remain/total);
      clock.classList.remove('over');
      clock.classList.toggle('warning',phase==='exam'&&cfg.warn>0&&remain<=cfg.warn);
      clock.classList.toggle('paused',!running&&remain<total);
      $('btnStart').textContent=running?'暫停':(remain<total?'繼續':'開始');
    }
    $('btnSkip').disabled=!(phase==='read'&&!over);
  }
  function setRing(frac){
    frac=Math.min(1,Math.max(0,frac));
    $('ringProg').style.strokeDasharray=RING_LEN;
    $('ringProg').style.strokeDashoffset=RING_LEN*frac;
  }
  function renderChips(){
    $('stationChips').innerHTML=stations.map((s,i)=>'<button type="button" class="chip'+(i===cur?' on':'')+'" data-i="'+i+'">'+esc(s.name)+'</button>').join('');
    $('stationChips').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{cur=+b.dataset.i;save();reset();toast('已切換至 '+stations[cur].name);}));
    $('stationCount').textContent=stations.length+' 站';
  }
  function renderStList(){
    $('stList').innerHTML=stations.map((s,i)=>'<div class="strow"><input type="text" id="sn'+i+'" value="'+esc(s.name)+'" data-i="'+i+'" data-k="name" aria-label="站名"><input type="text" id="st'+i+'" value="'+esc(s.task)+'" data-i="'+i+'" data-k="task" placeholder="任務／考題（模擬）" aria-label="任務"></div>').join('');
    $('stList').querySelectorAll('input').forEach(inp=>inp.addEventListener('input',e=>{stations[+e.target.dataset.i][e.target.dataset.k]=e.target.value;save();renderChips();render();}));
  }
  function renderLog(){
    const rows=log.slice().reverse();
    $('logCount').textContent=log.length+' 筆';
    $('statCount').textContent=log.length;
    $('statOver').textContent=log.filter(r=>r.over>0).length;
    const avg=log.length?log.reduce((a,r)=>a+r.used,0)/log.length:0;
    $('statAvg').textContent=log.length?fmt(avg):'—';
    if(!rows.length){$('logTable').innerHTML='';$('logEmpty').hidden=false;return;}
    $('logEmpty').hidden=true;
    $('logTable').innerHTML='<thead><tr><th>#</th><th>時間</th><th>站別</th><th>學員</th><th>用時</th><th>超時</th><th>結果</th></tr></thead><tbody>'+
      rows.map((r,i)=>'<tr><td class="num">'+(log.length-i)+'</td><td class="num">'+r.at+'</td><td>'+esc(r.station)+'</td><td>'+esc(r.student)+'</td><td class="num">'+fmt(r.used)+'</td><td class="num'+(r.over>0?' over':'')+'">'+(r.over>0?'+'+fmt(r.over):'—')+'</td><td class="'+(r.over>0?'over':'ok')+'">'+(r.over>0?'超時':(r.early?'提前結束':'準時'))+'</td></tr>').join('')+'</tbody>';
  }

  /* ---------- 計時核心 ---------- */
  function tick(){
    if(!running)return;
    if(over){render();raf=requestAnimationFrame(tick);return;}
    const now=performance.now();remainMs-=now-lastTick;lastTick=now;
    if(phase==='exam'&&cfg.warn>0&&!warned&&remainMs<=cfg.warn*1000&&remainMs>0){
      warned=true;beep([[880,0.18],[880,0.18]]);vibrate([200,100,200]);speak('剩餘'+Math.round(cfg.warn/60)+'分鐘');toast('剩餘 '+fmt(cfg.warn)+'，請準備收尾');
    }
    if(remainMs<=0){
      if(phase==='read'){phase='exam';remainMs=cfg.exam*1000;examStartedAt=now;beep([[1100,0.3]]);speak('測驗開始');toast('閱題結束，測驗開始');}
      else{remainMs=0;over=true;overStart=now;startAlarm();speak('時間到');toast('時間到，請停止測驗');}
    }
    render();raf=requestAnimationFrame(tick);
  }
  function startPause(){
    if(over){
      if(alarmTimer){stopAlarm();render();toast('鈴聲已停止，請按「下一位」記錄');}
      return;
    }
    if(running){running=false;cancelAnimationFrame(raf);}
    else{
      running=true;lastTick=performance.now();
      if(phase==='exam'&&examStartedAt===null)examStartedAt=lastTick;
      beep([[1100,0.12]]);keepAwake();raf=requestAnimationFrame(tick);
    }
    render();
  }
  function reset(silent){
    running=false;over=false;warned=false;examStartedAt=null;stopAlarm();cancelAnimationFrame(raf);
    readCfg();
    phase=cfg.read>0?'read':'exam';
    remainMs=(phase==='read'?cfg.read:cfg.exam)*1000;
    renderChips();render();
    if(!silent)toast('已重設');
  }
  function skipRead(){if(phase==='read'&&!over){phase='exam';remainMs=cfg.exam*1000;warned=false;examStartedAt=running?performance.now():null;lastTick=performance.now();render();toast('已跳過閱題');}}
  function finishAndNext(){
    const st=stations[cur];
    const started=examStartedAt!==null||phase==='exam'&&remainMs<cfg.exam*1000;
    if(started||over){
      const used=over?cfg.exam+(performance.now()-overStart)/1000:(cfg.exam-remainMs/1000);
      log.push({at:nowStr(),station:st.name,student:cfg.student,used:Math.round(used),over:over?Math.round((performance.now()-overStart)/1000):0,early:!over&&remainMs>0});
      renderLog();
    }
    cfg.student=nextName(cfg.student);
    $('cfgStudent').value=cfg.student;
    reset(true);toast('換 '+cfg.student+'，倒數已重設');
  }
  function nextName(s){
    const m=s.match(/^(.*?)([A-Za-z])$/);
    if(m){const c=m[2];return m[1]+(c==='Z'?'A':c==='z'?'a':String.fromCharCode(c.charCodeAt(0)+1));}
    const n=s.match(/^(.*?)(\d+)$/);return n?n[1]+(parseInt(n[2],10)+1):s+' 2';
  }
  let wake=null;
  async function keepAwake(){try{if('wakeLock'in navigator&&!wake){wake=await navigator.wakeLock.request('screen');wake.addEventListener('release',()=>{wake=null});}}catch(e){}}

  /* ---------- 匯出 ---------- */
  function logCsv(){
    const head='序號,時間,站別,學員,用時(秒),超時(秒),結果';
    return [head].concat(log.map((r,i)=>[i+1,r.at,r.station,r.student,r.used,r.over,r.over>0?'超時':(r.early?'提前結束':'準時')].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(','))).join('\n');
  }
  async function copyText(text,ok){
    try{await navigator.clipboard.writeText(text);toast(ok);}
    catch(e){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast(ok);}catch(_){toast('無法複製，請手動選取');}ta.remove();}
  }

  /* ---------- 主題 ---------- */
  function toggleTheme(){
    const root=document.documentElement;
    const dark=root.getAttribute('data-theme')==='dark'||(!root.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme',dark?'light':'dark');
    try{localStorage.setItem(KEY+'-theme',dark?'light':'dark');}catch(e){}
  }
  try{const t=localStorage.getItem(KEY+'-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}

  /* ---------- 事件 ---------- */
  $('btnStart').addEventListener('click',startPause);
  $('btnReset').addEventListener('click',()=>reset());
  $('btnNext').addEventListener('click',finishAndNext);
  $('btnSkip').addEventListener('click',skipRead);
  $('btnTheme').addEventListener('click',toggleTheme);
  $('btnFull').addEventListener('click',()=>{try{if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen().catch(()=>toast('此環境不支援全螢幕'));}catch(e){toast('此環境不支援全螢幕');}});
  $('btnTestSound').addEventListener('click',()=>{beep([[880,0.18],[880,0.18],[1046,0.5]]);vibrate([200]);speak('測試提示音');toast('已播放測試音');});
  $('btnCopyLog').addEventListener('click',()=>copyText(logCsv(),'已複製 CSV，可貼到 Excel'));
  $('btnClearLog').addEventListener('click',()=>{if(!log.length)return;if($('btnClearLog').dataset.arm==='1'){log=[];save();renderLog();$('btnClearLog').dataset.arm='';$('btnClearLog').textContent='清除紀錄';toast('紀錄已清除');}else{$('btnClearLog').dataset.arm='1';$('btnClearLog').textContent='再按一次確認清除';setTimeout(()=>{$('btnClearLog').dataset.arm='';$('btnClearLog').textContent='清除紀錄';},3000);}});
  ['cfgRead','cfgMin','cfgWarn','cfgSound','cfgVoice','cfgRepeat','cfgStudent'].forEach(id=>$(id).addEventListener('change',()=>{readCfg();if(!running&&!over)reset(true);else render();}));
  document.querySelectorAll('.preset').forEach(b=>b.addEventListener('click',()=>{$('cfgMin').value=b.dataset.min;readCfg();if(!running&&!over)reset(true);else render();toast('每站 '+b.dataset.min+' 分鐘');}));
  $('btnAddSt').addEventListener('click',()=>{stations.push({name:'第 '+(stations.length+1)+' 站',task:''});save();renderStList();renderChips();render();});
  $('btnDelSt').addEventListener('click',()=>{if(stations.length>1){stations.pop();if(cur>=stations.length)cur=stations.length-1;save();renderStList();renderChips();render();}});
  document.addEventListener('keydown',e=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;
    if(e.code==='Space'){e.preventDefault();startPause();}
    else if(e.key==='n'||e.key==='N')finishAndNext();
    else if(e.key==='r'||e.key==='R')reset();
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&running)keepAwake();});

  /* ---------- 初始化 ---------- */
  load();writeCfg();renderStList();renderLog();reset(true);
})();
