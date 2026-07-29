const $=id=>document.getElementById(id);
let file=null,result=null,definitions={},audio=new Audio(),audioUrl=null,audioContext=null,beatIndex=0,frameId=0,flashTimer=0;
let packageBase='',audioOutputName='',importedExtras=[],trackExtras={},resourcePreviewUrls=[];
let previewWindowStart=-1;
const PREVIEW_WINDOW_MS=12000;
const MAX_PACKAGE_BYTES=200*1024*1024,MAX_ZIP_ENTRIES=4096,MAX_TRACK_JSON_BYTES=1024*1024;
const defaults={engine:'fast',offset:'0',minimum:'200',rounding:'10',tolerance:'0.2'};
const defaultDefinitions=()=>({
  normal_beat:{can_attack:true,color:'#FFFFFF',scale:1,category:'normal',haptic_intensity:1,tolerance:.2},
  empty_beat:{can_attack:false,color:'#BEBEBE',scale:.7,category:'normal',haptic_intensity:1,tolerance:.2},
  weak_beat:{can_attack:true,color:'#00FFFF',scale:.9,category:'weakbeat',haptic_intensity:1,tolerance:.2},
  strong_beat:{can_attack:true,color:'#FFFF00',scale:1.2,category:'downbeat',haptic_intensity:1,tolerance:.2}
});
const clock=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const stamp=ms=>`${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')}.${String(Math.max(0,ms%1000)).padStart(3,'0')}`;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colorOf=type=>/^#[0-9a-f]{6}$/i.test(definitions[type]?.color||'')?definitions[type].color:'#73e6ff';

function useAudioFile(f){stopPreview();if(audioUrl)URL.revokeObjectURL(audioUrl);file=f;audioUrl=URL.createObjectURL(f);audio.src=audioUrl}
function notifyAdvanced(external=true){window.AdvancedEditor?.setProject(result,external)}
function setGlobalStatus(message,error=false){$('status').textContent=message;$('status').style.color=error?'#ff9b9b':''}
function selectFile(f){if(!f)return;if(f.name.toLowerCase().endsWith('.djcraft')){setGlobalStatus('自动检测仅接受音频；曲目包请在高级编辑中导入',true);return}useAudioFile(f);result=null;definitions={};importedExtras=[];trackExtras={};renderResources();packageBase=safeStem(f.name);audioOutputName=packageBase+'.ogg';$('resultCard').classList.add('hidden');$('fileTitle').textContent=f.name;$('fileMeta').textContent=`${(f.size/1048576).toFixed(1)} MB · ${f.type||'音频文件'}`;$('analyze').disabled=false;$('buttonText').textContent='开始检测';setGlobalStatus('已就绪，点击开始检测');notifyAdvanced(true)}
$('choose').onclick=()=>$('audio').click();$('audio').onchange=e=>selectFile(e.target.files[0]);
$('replaceAutoAudio').onclick=()=>$('audio').click();
['dragenter','dragover'].forEach(x=>$('dropzone').addEventListener(x,e=>{e.preventDefault();$('dropzone').classList.add('drag')}));
['dragleave','drop'].forEach(x=>$('dropzone').addEventListener(x,e=>{e.preventDefault();$('dropzone').classList.remove('drag')}));
$('dropzone').ondrop=e=>selectFile(e.dataTransfer.files[0]);
document.querySelectorAll('.modeTab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.modeTab').forEach(x=>{let active=x===tab;x.classList.toggle('active',active);x.setAttribute('aria-selected',String(active))});document.querySelectorAll('.modePanel').forEach(x=>x.classList.toggle('hidden',x.id!==tab.dataset.panel));if(tab.dataset.panel==='advancedPanel')window.AdvancedEditor?.activate()});

function resourceBytes(resource){return resource.data instanceof Uint8Array?resource.data:new Uint8Array(resource.data)}
async function addResource(name,fileData){
  name=zipPath(name);
  let data=fileData instanceof Uint8Array?fileData:new Uint8Array(await fileData.arrayBuffer());
  let existing=importedExtras.find(x=>x.name===name);
  if(existing)existing.data=data;else importedExtras.push({name,data});
  importedExtras.sort((a,b)=>a.name.localeCompare(b.name));
  renderResources();
}
function renderResources(){
  let list=$('resourceList'),urls=[];
  resourcePreviewUrls.forEach(URL.revokeObjectURL);resourcePreviewUrls=[];
  $('resourceCount').textContent=`${importedExtras.length} 个资源`;
  if(!importedExtras.length){list.innerHTML='<p class="emptyResources">尚未添加自定义资源</p>';return}
  list.innerHTML=importedExtras.map((resource,index)=>{
    let data=resourceBytes(resource),isPng=resource.name.toLowerCase().endsWith('.png'),url=isPng?URL.createObjectURL(new Blob([data],{type:'image/png'})):'';
    if(url)urls.push(url);
    return `<div class="resourceRow"><div>${url?`<img class="resourceThumb" src="${url}" alt="">`:'<span class="resourceThumb"></span>'}</div><code>${esc(resource.name)}</code><span class="resourceSize">${(data.length/1024).toFixed(data.length<10240?1:0)} KB</span><button class="resourceDelete" data-resource="${index}" title="删除资源" aria-label="删除 ${esc(resource.name)}">删除</button></div>`
  }).join('');
  resourcePreviewUrls=urls;
}
document.querySelectorAll('.resourceChoose').forEach(button=>button.onclick=() => $(button.dataset.input).click());
$('discResource').onchange=e=>{let picked=e.target.files[0];if(picked)addResource('disc.png',picked);e.target.value=''};
$('perfectDiscResource').onchange=e=>{let picked=e.target.files[0];if(picked)addResource('perfect_disc.png',picked);e.target.value=''};
$('comboThreshold').oninput=e=>{let value=Number(e.target.value);$('comboPath').textContent=value===1?'combo/0.png … 9.png':`combo/${value||'?'}/0.png … 9.png`};
$('comboResources').onchange=e=>{$('comboNames').textContent=e.target.files.length?`${e.target.files.length} 个文件待添加`:'未选择'};
$('addComboResources').onclick=async()=>{
  let threshold=Number($('comboThreshold').value),files=[...$('comboResources').files];
  if(!Number.isInteger(threshold)||threshold<1||threshold>2147483647||threshold!==1&&threshold<2){$('comboNames').textContent='请输入有效阈值';return}
  if(!files.length){$('comboNames').textContent='请先选择数字图片';return}
  let valid=files.filter(x=>/^[0-9]\.png$/i.test(x.name));
  if(!valid.length){$('comboNames').textContent='文件名必须是 0.png–9.png';return}
  let prefix=threshold===1?'combo/':`combo/${threshold}/`;
  for(let picked of valid)await addResource(prefix+picked.name.toLowerCase(),picked);
  $('comboResources').value='';$('comboNames').textContent=`已添加 ${valid.length} 个${valid.length<files.length?`，忽略 ${files.length-valid.length} 个无效文件`:''}`;
};
$('resourceList').onclick=e=>{let button=e.target.closest('.resourceDelete');if(!button)return;importedExtras.splice(Number(button.dataset.resource),1);renderResources()};
renderResources();
addEventListener('beforeunload',()=>resourcePreviewUrls.forEach(URL.revokeObjectURL));
function config(){let c={};Object.keys(defaults).forEach(k=>c[k]=$(k).value);return{...c,version:'1.0',author:'BeatDetector',difficulty:'normal',bpm:'',duration_ms:'',display_name:packageBase||'',crosshair_mode:'beat',crosshair_beat_count:2,crosshair_time_ms:1400}}
$('reset').onclick=()=>Object.entries(defaults).forEach(([k,v])=>$(k).value=v);
$('analyze').onclick=async()=>{if(!file)return;let fd=new FormData();fd.append('audio',file);fd.append('config',JSON.stringify(config()));$('analyze').disabled=true;$('analyze').setAttribute('aria-busy','true');$('buttonText').textContent='正在分析…';setGlobalStatus('正在提取节拍，请稍候');$('status').classList.add('loading');try{let r=await fetch('/api/detect',{method:'POST',body:fd}),data=await r.json();if(!r.ok)throw Error(data.error||'检测失败');result=data;definitions=structuredClone(data.track.definitions);render(data)}catch(e){setGlobalStatus(e.message||'检测失败',true)}finally{$('status').classList.remove('loading');$('analyze').disabled=false;$('analyze').removeAttribute('aria-busy');$('buttonText').textContent=result?'重新检测':'开始检测'}};

function recalculateStats(){
  if(!result)return;
  let beats=result.track.timeline.combat_line||[],durationMs=Math.max(0,Number(result.track.meta.total_duration_ms)||0),duration=durationMs/1000,bpmValue=Number(result.track.meta.bpm)||0;
  result.stats={...(result.stats||{}),total:beats.length,normal:beats.filter(x=>x.type==='normal_beat').length,bpm:bpmValue,duration,density:duration?Math.round(beats.length/duration*100)/100:0};
}
function syncAutoControlsFromTrack(){
  if(!result)return;
  recalculateStats();
  let s=result.stats,dur=result.track.meta.total_duration_ms;
  $('resultCard').classList.remove('hidden');$('bpm').textContent=s.bpm;$('hits').textContent=s.total;$('duration').textContent=clock(s.duration);$('density').textContent=s.density;$('playerDuration').textContent=stamp(dur);definitions=structuredClone(result.track.definitions);renderAssignments();
}
function render(d){stopPreview();syncAutoControlsFromTrack();$('method').textContent=d.method;setGlobalStatus(`完成 · ${d.processing_seconds} 秒 · ${d.stats.total} 个节拍`);notifyAdvanced(true)}
function previewBounds(ms){
  let duration=Math.max(1,Number(result?.track?.meta?.total_duration_ms)||1);
  let safeMs=Math.max(0,Math.min(Math.round(ms),Math.max(0,duration-1)));
  let page=Math.floor(safeMs/PREVIEW_WINDOW_MS),start=page*PREVIEW_WINDOW_MS,end=Math.min(duration,start+PREVIEW_WINDOW_MS);
  return{start,end,duration,span:end-start,page}
}
function renderPreviewWindow(ms=0,force=false){
  if(!result)return;
  let beats=result.track.timeline.combat_line||[],bounds=previewBounds(ms),track=$('track');
  if(force||bounds.start!==previewWindowStart){
    previewWindowStart=bounds.start;
    let visible=[];for(let i=0;i<beats.length;i++)if(beats[i].t>=bounds.start&&beats[i].t<=bounds.end)visible.push({hit:beats[i],index:i});
    let markers='';
    if(visible.length<=80){
      markers=visible.map((item,i)=>`<i class="tick" data-beat="${item.index}" title="${esc(item.hit.type)} · ${stamp(item.hit.t)}" style="left:${(item.hit.t-bounds.start)/(bounds.end-bounds.start)*100}%;--event-color:${colorOf(item.hit.type)};--lane:${i%3}"></i>`).join('');
    }else{
      let bucketCount=80,buckets=Array.from({length:bucketCount},()=>({count:0,type:''}));
      visible.forEach(item=>{let index=Math.min(bucketCount-1,Math.floor((item.hit.t-bounds.start)/(bounds.end-bounds.start)*bucketCount));buckets[index].count++;buckets[index].type||=item.hit.type});
      let max=Math.max(...buckets.map(x=>x.count),1);
      markers=buckets.map((bucket,i)=>bucket.count?`<i class="tick density" title="${bucket.count} 个节拍" style="left:${(i+.5)/bucketCount*100}%;--event-color:${colorOf(bucket.type)};--density:${bucket.count/max}"></i>`:'').join('');
    }
    track.innerHTML=markers+'<i class="playhead" id="playhead"></i>';
    $('windowStartTime').textContent=stamp(bounds.start);$('midtime').textContent=stamp((bounds.start+bounds.end)/2);$('endtime').textContent=stamp(bounds.end);$('previewWindowCount').textContent=`第 ${bounds.page+1} 段 · ${visible.length} 个节拍 · ${Math.round((bounds.end-bounds.start)/1000)} 秒`;
  }
  let playhead=$('playhead');if(playhead)playhead.style.left=Math.max(0,Math.min(100,(ms-bounds.start)/(bounds.end-bounds.start)*100))+'%';
}
function renderAssignments(){if(!result)return;previewWindowStart=-1;renderPreviewWindow(audio.currentTime*1000,true);$('definitionLegend').innerHTML=Object.keys(definitions).map(k=>`<span><i style="background:${colorOf(k)}"></i>${esc(k)}</span>`).join('')}

function findBeat(ms){let beats=result?.track.timeline.combat_line||[],i=0;while(i<beats.length&&beats[i].t<ms-35)i++;return i}
function clickBeat(type){if(!$('metronome').checked)return;audioContext=audioContext||new(window.AudioContext||window.webkitAudioContext)();let idx=Math.max(0,Object.keys(definitions).indexOf(type)),now=audioContext.currentTime,osc=audioContext.createOscillator(),gain=audioContext.createGain(),volume=Math.max(1,Math.min(10,Number($('metronomeVolume').value)||1));osc.frequency.setValueAtTime(650+idx*130,now);gain.gain.setValueAtTime(.14*volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+.065);osc.connect(gain).connect(audioContext.destination);osc.start(now);osc.stop(now+.07)}
function pulse(hit,index){let el=$('beatPulse');clearTimeout(flashTimer);el.className='beatPulse hit';el.style.background=colorOf(hit.type);$('beatType').textContent=hit.type;document.querySelectorAll('.tick.active').forEach(x=>x.classList.remove('active'));document.querySelector(`.tick[data-beat="${index}"]`)?.classList.add('active');flashTimer=setTimeout(()=>{el.className='beatPulse';el.style.background=''},105)}
function animate(){if(!result)return;let ms=audio.currentTime*1000,dur=result.track.meta.total_duration_ms,beats=result.track.timeline.combat_line;$('seek').value=Math.min(1000,ms/dur*1000||0);$('currentTime').textContent=stamp(Math.max(0,Math.round(ms)));renderPreviewWindow(ms);while(beatIndex<beats.length&&beats[beatIndex].t<=ms+25){if(beats[beatIndex].t>=ms-90){clickBeat(beats[beatIndex].type);pulse(beats[beatIndex],beatIndex)}beatIndex++}if(!audio.paused)frameId=requestAnimationFrame(animate)}
function stopPreview(){audio.pause();audio.currentTime=0;beatIndex=0;cancelAnimationFrame(frameId);if($('play'))$('play').textContent='▶';if($('seek'))$('seek').value=0;if($('currentTime'))$('currentTime').textContent='0:00.000';if(result)renderPreviewWindow(0,true);if($('track'))$('track').classList.remove('playing')}
$('play').onclick=async()=>{if(!result||!audioUrl)return;if(audio.paused){beatIndex=findBeat(audio.currentTime*1000);await audio.play();$('play').textContent='Ⅱ';$('track').classList.add('playing');animate()}else{audio.pause();$('play').textContent='▶';$('track').classList.remove('playing');cancelAnimationFrame(frameId)}};
$('stop').onclick=stopPreview;$('volume').oninput=e=>audio.volume=Number(e.target.value);$('metronomeVolume').onchange=e=>{if($('advMetronomeVolume'))$('advMetronomeVolume').value=e.target.value};$('seek').oninput=e=>{if(!result)return;audio.currentTime=Number(e.target.value)/1000*result.track.meta.total_duration_ms/1000;beatIndex=findBeat(audio.currentTime*1000);animate()};$('track').onclick=e=>{if(!result)return;let rect=e.currentTarget.getBoundingClientRect(),bounds=previewBounds(audio.currentTime*1000),ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));audio.currentTime=(bounds.start+ratio*(bounds.end-bounds.start))/1000;beatIndex=findBeat(audio.currentTime*1000);animate()};$('track').onkeydown=e=>{if(!result||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();audio.currentTime=Math.max(0,Math.min(result.track.meta.total_duration_ms/1000,audio.currentTime+(e.key==='ArrowLeft'?-1:1)));beatIndex=findBeat(audio.currentTime*1000);animate()};audio.onended=stopPreview;

function crc32(bytes){let c=0xffffffff;for(let b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function u16(n){let b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n,true);return b}function u32(n){let b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n>>>0,true);return b}
function join(parts){let size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size),at=0;for(let p of parts){out.set(p,at);at+=p.length}return out}
function makeZip(entries){let encoder=new TextEncoder(),locals=[],centrals=[],offset=0;for(let entry of entries){let name=encoder.encode(entry.name),data=entry.data,crc=crc32(data),local=join([u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);locals.push(local);centrals.push(join([u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=local.length}let central=join(centrals);return join([...locals,central,u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(central.length),u32(offset),u16(0)])}
function zipPath(name){
  if(!name||name.startsWith('/')||name.includes('\\')||name.includes(':'))throw Error(`曲目包包含不安全路径：${name||'(空路径)'}`);
  let parts=name.split('/'),check=name.endsWith('/')?parts.slice(0,-1):parts;
  if(check.some(x=>!x||x==='.'||x==='..'))throw Error(`曲目包包含不安全路径：${name}`);
  return name;
}
async function inflateRaw(data){
  if(typeof DecompressionStream==='undefined')throw Error('当前浏览器不支持读取 Deflate 压缩的曲目包');
  let stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readZip(blob){
  if(!blob||blob.size>MAX_PACKAGE_BYTES)throw Error('曲目包超过 200 MB 限制');
  let bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){eocd=i;break}
  if(eocd<0)throw Error('不是有效的 ZIP/.djcraft 文件');
  let count=view.getUint16(eocd+10,true),centralSize=view.getUint32(eocd+12,true),centralOffset=view.getUint32(eocd+16,true);
  if(view.getUint16(eocd+4,true)!==0||view.getUint16(eocd+6,true)!==0)throw Error('不支持多磁盘 ZIP 曲目包');
  if(count>MAX_ZIP_ENTRIES)throw Error(`曲目包文件项超过 ${MAX_ZIP_ENTRIES} 个限制`);
  if(centralOffset+centralSize>bytes.length)throw Error('曲目包的 ZIP 目录已损坏');
  let decoder=new TextDecoder('utf-8',{fatal:true}),records=[],names=new Set(),total=0,at=centralOffset;
  for(let i=0;i<count;i++){
    if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)throw Error('曲目包的 ZIP 目录已损坏');
    let flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),compressedSize=view.getUint32(at+20,true),size=view.getUint32(at+24,true),nameLength=view.getUint16(at+28,true),extraLength=view.getUint16(at+30,true),commentLength=view.getUint16(at+32,true),localOffset=view.getUint32(at+42,true);
    if(compressedSize===0xffffffff||size===0xffffffff||localOffset===0xffffffff)throw Error('暂不支持 ZIP64 曲目包');
    if(flags&1)throw Error('不支持加密的 .djcraft 曲目包');
    if(method!==0&&method!==8)throw Error(`曲目包使用了不支持的 ZIP 压缩方式：${method}`);
    let end=at+46+nameLength+extraLength+commentLength;if(end>bytes.length)throw Error('曲目包的 ZIP 目录已截断');
    let name;try{name=zipPath(decoder.decode(bytes.subarray(at+46,at+46+nameLength)))}catch(e){if(e instanceof TypeError)throw Error('曲目包包含非 UTF-8 文件名');throw e}
    if(names.has(name))throw Error(`曲目包包含重复文件项：${name}`);names.add(name);
    if(!name.endsWith('/')){total+=size;if(total>MAX_PACKAGE_BYTES)throw Error('曲目包解压后超过 200 MB 限制');records.push({name,flags,method,crc,compressedSize,size,localOffset})}
    at=end;
  }
  let entries=new Map();
  for(let record of records){
    let p=record.localOffset;
    if(p+30>bytes.length||view.getUint32(p,true)!==0x04034b50)throw Error(`曲目包文件项已损坏：${record.name}`);
    if(view.getUint16(p+8,true)!==record.method)throw Error(`曲目包文件项压缩信息不一致：${record.name}`);
    let localNameLength=view.getUint16(p+26,true),localExtraLength=view.getUint16(p+28,true),start=p+30+localNameLength+localExtraLength,end=start+record.compressedSize;
    if(end>bytes.length)throw Error(`曲目包文件项已截断：${record.name}`);
    let localName;try{localName=decoder.decode(bytes.subarray(p+30,p+30+localNameLength))}catch{throw Error(`曲目包文件名编码无效：${record.name}`)}
    if(localName!==record.name)throw Error(`曲目包文件项名称不一致：${record.name}`);
    let data=bytes.slice(start,end);
    if(record.method===8)data=await inflateRaw(data);
    if(data.length!==record.size)throw Error(`曲目包文件大小不匹配：${record.name}`);
    if(crc32(data)!==record.crc)throw Error(`曲目包文件校验失败：${record.name}`);
    entries.set(record.name,data);
  }
  return entries;
}
function validateImportedTrack(track){
  if(!track||typeof track!=='object'||Array.isArray(track))throw Error('track.json 顶层必须是对象');
  if(!track.meta||typeof track.meta!=='object'||Array.isArray(track.meta))throw Error('track.json 缺少有效的 meta');
  if(!track.definitions||typeof track.definitions!=='object'||Array.isArray(track.definitions)||!Object.keys(track.definitions).length)throw Error('track.json 缺少有效的 definitions');
  if(!track.timeline||typeof track.timeline!=='object'||!Array.isArray(track.timeline.combat_line))throw Error('track.json 缺少 timeline.combat_line');
  for(let [lineName,line] of Object.entries(track.timeline)){
    if(!Array.isArray(line))throw Error(`timeline.${lineName} 必须是事件数组`);
    for(let [i,hit] of line.entries()){
      if(!hit||typeof hit!=='object'||Array.isArray(hit)||!Number.isFinite(Number(hit.t))||typeof hit.type!=='string'||!hit.type)throw Error(`timeline.${lineName}[${i}] 缺少有效的 t 或 type`);
      if(hit.props!==undefined){
        if(!hit.props||typeof hit.props!=='object'||Array.isArray(hit.props))throw Error(`timeline.${lineName}[${i}].props 必须是对象`);
        for(let [key,value] of Object.entries(hit.props))if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error(`timeline.${lineName}[${i}].props.${key} 只支持有限数值、布尔或字符串`);
      }
      hit.t=Math.round(Number(hit.t));
    }
    line.sort((a,b)=>a.t-b.t);
  }
  track.settings=track.settings&&typeof track.settings==='object'&&!Array.isArray(track.settings)?track.settings:{};
}
function mimeFor(name){let ext=name.toLowerCase().split('.').pop();return({ogg:'audio/ogg',mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'})[ext]||'application/octet-stream'}
async function importPackage(packageFile,scrollToResult=true){
  if(!packageFile)return;
  $('status').textContent='正在解析 .djcraft 曲目包…';$('status').classList.add('loading');$('analyze').disabled=true;
  try{
    let entries=await readZip(packageFile),trackBytes=entries.get('track.json');
    if(!trackBytes)throw Error('曲目包根目录缺少 track.json');
    if(trackBytes.length>MAX_TRACK_JSON_BYTES)throw Error('track.json 超过 1 MB 限制');
    let track;try{track=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(trackBytes).replace(/^\uFEFF/,''))}catch(e){throw Error(`track.json 解析失败：${e.message}`)}
    validateImportedTrack(track);
    let soundName=typeof track.meta.sound_file==='string'&&track.meta.sound_file?zipPath(track.meta.sound_file):'track.ogg',soundBytes=entries.get(soundName);
    if(!soundBytes)throw Error(`曲目包缺少 meta.sound_file 指定的音频：${soundName}`);
    let audioFile=new File([soundBytes],soundName,{type:mimeFor(soundName)});
    useAudioFile(audioFile);
    packageBase=safeStem(packageFile.name);audioOutputName=soundName;
    importedExtras=[...entries].filter(([name])=>name!=='track.json'&&name!==soundName).map(([name,data])=>({name,data}));
    trackExtras=Object.fromEntries(Object.entries(track).filter(([key])=>!['meta','settings','definitions','timeline','stats'].includes(key)));
    let durationMs=Number(track.meta.total_duration_ms)||0,beats=track.timeline.combat_line,duration=durationMs/1000,bpm=Number(track.meta.bpm)||0;
    result={success:true,track,stats:{total:beats.length,normal:beats.filter(x=>x.type==='normal_beat').length,bpm,duration,density:duration?Math.round(beats.length/duration*100)/100:0},processing_seconds:0,method:'DJCraft 导入'};
    definitions=structuredClone(track.definitions);renderResources();$('fileTitle').textContent=packageFile.name;$('fileMeta').textContent=`${(packageFile.size/1048576).toFixed(1)} MB · 已载入 ${entries.size} 个文件项`;
    render(result,scrollToResult);setGlobalStatus(`已导入 ${packageFile.name} · ${beats.length} 个节拍${importedExtras.length?` · 将保留 ${importedExtras.length} 个附加资源`:''}`);
  }catch(e){setGlobalStatus('导入失败：'+e.message,true)}
  finally{$('status').classList.remove('loading');$('analyze').disabled=!file;$('advancedPackageInput').value=''}
}
function safeStem(name){let stem=name.replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/_+/g,'_').replace(/^[._-]+|[._-]+$/g,'');return stem||'Track'}
function syncTrackSettings(audioName){
  if(!result)return;
  result.track.meta.sound_file=audioName||result.track.meta.sound_file;
}
function waitForAudioMetadata(){
  if(Number.isFinite(audio.duration)&&audio.duration>0)return Promise.resolve(audio.duration);
  return new Promise((resolve,reject)=>{
    let timer=setTimeout(()=>{cleanup();reject(Error('读取音频时长超时'))},12000);
    let done=()=>{cleanup();Number.isFinite(audio.duration)&&audio.duration>0?resolve(audio.duration):reject(Error('浏览器未能读取音频时长'))};
    let fail=()=>{cleanup();reject(Error('浏览器无法载入该音频'))};
    function cleanup(){clearTimeout(timer);audio.removeEventListener('loadedmetadata',done);audio.removeEventListener('error',fail)}
    audio.addEventListener('loadedmetadata',done);audio.addEventListener('error',fail);
  });
}
async function createBlankProject(audioFile){
  if(!audioFile)return;
  useAudioFile(audioFile);packageBase=safeStem(audioFile.name);audioOutputName=packageBase+'.ogg';importedExtras=[];trackExtras={};renderResources();
  $('fileTitle').textContent=audioFile.name;$('fileMeta').textContent=`${(audioFile.size/1048576).toFixed(1)} MB · 高级编辑空白工程`;
  let durationSeconds;
  try{durationSeconds=await waitForAudioMetadata()}catch(error){setGlobalStatus(error.message,true);return}
  let durationMs=Math.max(1,Math.round(durationSeconds*1000)),displayName=safeStem(audioFile.name);
  result={success:true,track:{meta:{version:'1.0',author:'BeatDetector',bpm:120,difficulty:'normal',sound_file:audioOutputName,offset_ms:0,playback_start_ms:0,total_duration_ms:durationMs,display_name:displayName},settings:{crosshair_mode:'beat',crosshair_time_ms:1400,crosshair_beat_count:4,volume_multiplier:1},definitions:defaultDefinitions(),timeline:{combat_line:[]}},stats:{total:0,normal:0,bpm:120,duration:durationSeconds,density:0},processing_seconds:0,method:'高级编辑空白工程'};
  definitions=structuredClone(result.track.definitions);render(result,false);setGlobalStatus(`已创建空白工程 · ${stamp(durationMs)} · 双击轨道添加节拍`);
}
async function exportProject(button=$('advExport')){
  if(!result||!file)return setGlobalStatus('请先载入音频或曲目包',true);
  let old=button.textContent;button.disabled=true;
  try{
    recalculateStats();
    let base=packageBase||safeStem(file.name),audioName=audioOutputName||safeStem(file.name)+'.ogg',packageName=base+'.djcraft';syncTrackSettings(audioName);
    let oggData;
    if(file.name.toLowerCase().endsWith('.ogg')){button.textContent='正在打包…';setGlobalStatus('正在打包曲目资源…');oggData=new Uint8Array(await file.arrayBuffer())}
    else{button.textContent='正在转码 OGG…';setGlobalStatus('正在将音频转换为 OGG，请稍候');let convertForm=new FormData();convertForm.append('audio',file);let converted=await fetch('/api/convert-ogg',{method:'POST',body:convertForm});if(!converted.ok){let err=await converted.json().catch(()=>({error:'OGG 转码失败'}));throw Error(err.error||'OGG 转码失败')}oggData=new Uint8Array(await converted.arrayBuffer());button.textContent='正在打包…'}
    let outputTrack={...trackExtras,meta:result.track.meta,settings:result.track.settings,definitions:result.track.definitions,timeline:result.track.timeline};
    let encoder=new TextEncoder(),trackJson=encoder.encode(JSON.stringify(outputTrack,null,2));if(trackJson.length>MAX_TRACK_JSON_BYTES)throw Error('track.json 超过 1 MB 限制');
    let entries=[{name:'track.json',data:trackJson},{name:audioName,data:oggData}],used=new Set(entries.map(x=>x.name));
    for(let extra of importedExtras)if(!used.has(extra.name)){entries.push({name:extra.name,data:resourceBytes(extra)});used.add(extra.name)}
    let blob=new Blob([makeZip(entries)],{type:'application/zip'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=packageName;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);setGlobalStatus(`已导出 ${packageName} · 音频 ${audioName}${importedExtras.length?` · 包含 ${importedExtras.length} 个自定义资源`:''}`);
  }catch(e){setGlobalStatus('打包失败：'+e.message,true)}
  finally{button.disabled=false;button.textContent=old}
}
window.AdvancedEditor.init({
  getProject:()=>result,
  getAudio:()=>audio,
  getAudioFile:()=>file,
  getProjectName:()=>packageBase,
  createBlankProject,
  importPackage:packageFile=>importPackage(packageFile,false),
  exportProject,
  replaceTrack:nextTrack=>{if(result){result.track=nextTrack;definitions=structuredClone(nextTrack.definitions||{})}},
  trackChanged:label=>{syncAutoControlsFromTrack();$('method').textContent='高级编辑';setGlobalStatus(label)},
  setStatus:setGlobalStatus
});
