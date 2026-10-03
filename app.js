const PN=["Arquero","Lateral izq","Central izq","Central der","Lateral der","Medio izq","Medio centro","Medio der","Extremo izq","Delantero","Extremo der"];
const POS=["ARQ","LI","DFC","DFC","LD","MC","MC","MC","EI","DC","ED"];
// Coordenadas vista vertical 4-3-3
const V=[[50,88],[12,67],[37,70],[63,70],[88,67],[22,46],[50,43],[78,46],[18,19],[50,14],[82,19]];
const C=["var(--t1)","var(--t2)"];
const K="f11c", K_SUBS="f11_subs", K_REF="f11_ref", K_CHAT="f11_chat", K_BETS="f11_bets";

// La caché permite ver los últimos datos; ningún guardado se confirma desde ella.
function readCache(key, fallback){
  try{return JSON.parse(localStorage.getItem(key)) ?? fallback}catch{return fallback}
}
function emptyTeam(size){return Array.from({length:size},()=>({}))}
function readTeams(key,size){
  const data=readCache(key,null);
  return [0,1].map(t=>Array.from({length:size},(_,i)=>{
    const p=data?.[t]?.[i];
    return p && typeof p==='object' && !Array.isArray(p)?p:{};
  }));
}
let S=readTeams(K,11),subs=readTeams(K_SUBS,5);
let referee=readCache(K_REF,{})||{};
let chatMessages=readCache(K_CHAT,[]),betsList=readCache(K_BETS,[]);
if(!Array.isArray(chatMessages))chatMessages=[];
if(!Array.isArray(betsList))betsList=[];
let tok='',me='',db=null,liveCh=null;
let sharedReady={players:false,bets:false,chat_messages:false};
let syncing=null,syncTimer=null,toastTimer=null,photoLoading=false,syncAgain=false,stateRevision=0;
try{
  tok=localStorage.getItem('f11tok')||crypto.randomUUID();
  localStorage.setItem('f11tok',tok);
}catch{}
const identityReady=(async()=>{
  if(!tok || !crypto.subtle)throw new Error('Abrí la web por HTTPS para usar tu acceso.');
  const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(tok));
  me=[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');
})();
identityReady.catch(()=>{});
try{
  db=supabase.createClient("https://xeukyzwstqbaciugubtf.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhldWt5endzdHFiYWNpdWd1YnRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NzM1NzAsImV4cCI6MjEwNjU0OTU3MH0.mP_dWBirPW8XJfJUeiLnrDZQqyVgMkuGvYrsRDj9yUU",{global:{headers:{'x-owner':tok}}});
}catch{}

function rememberName(name){try{localStorage.setItem('f11_name',name)}catch{}}
function rememberedName(){try{return localStorage.getItem('f11_name')||''}catch{return ''}}
function notifyUser(message){
  $('toast').textContent=message;$('toast').hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);
}
function setFeedback(id,message,success=false){
  const el=$(id);el.textContent=message;el.classList.toggle('success',success);
}
function connectionStatus(label,bad=false,detail='Tocá para actualizar los datos compartidos'){
  $('sync-status').textContent=label;
  $('sync-status').classList.toggle('offline',bad);$('sync-status').title=detail;
}
function backendError(error){
  if(error?.code==='PGRST202' || error?.code==='42P01' || error?.code==='42703')
    return 'Falta aplicar la reparación de Supabase. Avisale al organizador; el cambio no se confirmó.';
  if(error?.code==='42501')return 'No tenés permiso para guardar este cambio. Recuperá el acceso original.';
  if(/fetch|network|ECONN|AbortError/i.test(error?.message||''))return 'No se pudo conectar. Revisá internet y volvé a intentar; el cambio no se confirmó.';
  return error?.message || 'No se pudo conectar. Revisá internet y volvé a intentar.';
}
async function requireShared(table){
  await identityReady;
  if(!navigator.onLine)throw new Error('Estás sin conexión. Volvé a intentar con internet; el cambio no se confirmó.');
  if(!db)throw new Error('No se pudo conectar. Recargá la web con internet.');
  if(!sharedReady[table])await sync();
  if(!sharedReady[table])throw new Error('No se pudieron cargar los datos compartidos. Volvé a intentar con internet.');
}
function broadcast(event,payload){
  // Los avisos solo provocan una lectura de la base: nunca son prueba de guardado.
  if(liveCh)liveCh.send({type:'broadcast',event,payload}).catch(()=>{});
}

// Helper para slots (0..10 titulares, 11..15 suplentes, team 2 = árbitro)
function getSlotData(t,i){
  if(t===2)return referee;
  if(i>=11)return subs[t][i-11]||{};
  return S[t][i]||{};
}
function isMine(t,i){
  const p=getSlotData(t,i);
  if(!p.n)return true; // libre: cualquiera puede anotarse
  return !!me && (!p.o || p.o===me); // ocupado: solo quien lo anotó originalmente
}

// Aplicar datos recibidos de DB o Realtime
function applyPlayerRow(r){
  if(!r || ![0,1,2].includes(r.team) || !Number.isInteger(r.pos))return;
  if(r.team===2){
    referee={n:r.name||"",f:r.photo||"",o:r.owner||"",id:r.player_id||""};
    saveRef();
  }else if(r.pos>=11){
    const sIdx=r.pos-11;
    if(sIdx>=0&&sIdx<5){
      subs[r.team][sIdx]={n:r.name||"",f:r.photo||"",o:r.owner||"",id:r.player_id||"",c:!!r.is_captain};
      saveSubs();
    }
  }else if(r.pos>=0&&r.pos<=10){
    S[r.team][r.pos]={n:r.name||"",f:r.photo||"",o:r.owner||"",id:r.player_id||"",c:!!r.is_captain};
    save();
  }
}

// Persistencia en localStorage
const save=()=>{try{localStorage.setItem(K,JSON.stringify(S))}catch(e){}};
const saveSubs=()=>{try{localStorage.setItem(K_SUBS,JSON.stringify(subs))}catch(e){}};
const saveRef=()=>{try{localStorage.setItem(K_REF,JSON.stringify(referee))}catch(e){}};
const saveChat=()=>{try{localStorage.setItem(K_CHAT,JSON.stringify(chatMessages))}catch(e){}};
const saveBets=()=>{try{localStorage.setItem(K_BETS,JSON.stringify(betsList))}catch(e){}};

// Boletas nuevas y antiguas comparten un único formato en pantalla.
function mapBetRow(b){
  if(!b)return null;
  let p={};
  if(typeof b.team_pick==='string' && b.team_pick.trim().startsWith('{')){
    try{p=JSON.parse(b.team_pick)}catch{}
  }
  let s0=p.s0??b.s0,s1=p.s1??b.s1;
  if(s0===undefined || s1===undefined){
    const m=String(b.team_pick||'').match(/(\d+)\s*-\s*(\d+)/);
    [s0,s1]=m?[Number(m[1]),Number(m[2])]:b.team_pick==='1'?[1,2]:b.team_pick==='emp'?[1,1]:[2,1];
  }
  s0=Math.max(0,Math.min(15,Number(s0)||0));s1=Math.max(0,Math.min(15,Number(s1)||0));
  return {id:b.id,user:b.user_name||b.user||'Anónimo',s0,s1,
    team_pick:s0>s1?'0':s0<s1?'1':'emp',total_goals:s0+s1>=3?'mas':'menos',
    scorer:b.scorer||'',mvp:p.mvp||b.mvp||'',defender:p.defender||b.defender||'',
    keeper:p.keeper||b.keeper||'',assist:p.assist||b.assist||'',
    yellow_card:b.yellow_card||'',blooper:p.blooper||b.blooper||'',
    refs:p.refs||b.refs||{},amount:Number(b.amount)||500,
    time:b.created_at||b.time||new Date().toISOString(),owner:b.owner||''};
}
function canonicalBets(rows){
  const seen=new Set();
  return rows.map(mapBetRow).filter(Boolean).sort((a,b)=>new Date(b.time)-new Date(a.time)).filter(b=>{
    if(!b.owner)return true;
    if(seen.has(b.owner))return false;
    seen.add(b.owner);return true;
  });
}
function replacePlayers(rows){
  S=[emptyTeam(11),emptyTeam(11)];subs=[emptyTeam(5),emptyTeam(5)];referee={};
  rows.forEach(applyPlayerRow);save();saveSubs();saveRef();
}
async function sync(){
  if(syncing){syncAgain=true;return syncing}
  if(!db){connectionStatus('Sin conexión',true);return}
  syncing=(async()=>{
    connectionStatus('Actualizando…');
    const revision=stateRevision;
    const requests=await Promise.allSettled([
      db.from('players').select('*'),
      db.from('chat_messages').select('*').order('created_at',{ascending:false}).limit(50),
      db.from('bets').select('*').order('created_at',{ascending:false})
    ]);
    const tables=['players','chat_messages','bets'];let failures=[];
    // Una respuesta iniciada antes de un guardado no debe deshacerlo en pantalla.
    if(revision!==stateRevision){scheduleSync();return}
    requests.forEach((result,i)=>{
      const table=tables[i];
      if(result.status==='rejected' || result.value.error || !Array.isArray(result.value.data)){
        sharedReady[table]=false;failures.push(table);return;
      }
      sharedReady[table]=true;
      const rows=result.value.data;
      if(table==='players')replacePlayers(rows);
      if(table==='chat_messages'){
        chatMessages=rows.reverse().map(c=>({id:c.id,author:c.author,team:c.team,photo:c.photo,text:c.text,time:c.created_at,owner:c.owner}));saveChat();
      }
      if(table==='bets'){betsList=canonicalBets(rows);saveBets()}
    });
    refreshViews();
    const labels={players:'jugadores',chat_messages:'chat',bets:'Prode'};
    connectionStatus(failures.length===3?'Sin conexión':failures.length?'Conexión parcial':'Al día',!!failures.length,
      failures.length?'No se pudieron cargar: '+failures.map(t=>labels[t]).join(', ')+'. Tocá para reintentar.':'Datos compartidos actualizados. Tocá para actualizar.');
  })();
  try{await syncing}catch{connectionStatus('Sin conexión',true)}finally{
    syncing=null;if(syncAgain){syncAgain=false;scheduleSync()}
  }
}
function scheduleSync(){
  clearTimeout(syncTimer);syncTimer=setTimeout(()=>sync(),150);
}
function handleLiveNotice({payload}){if(payload)scheduleSync()}
function refreshViews(){
  refreshBetNames();render();renderChat();renderBets();renderAllStatPickers();updateNote(true);
  if($('dlg-player-picker').open)filterPickerPlayers();
}
function startRealtime(){
  if(!db)return;
  for(const table of ['players','chat_messages','bets']){
    db.channel(table+'_ch').on('postgres_changes',{event:'*',schema:'public',table},scheduleSync).subscribe();
  }
  liveCh=db.channel('centenario_live',{config:{broadcast:{self:false}}});
  for(const event of ['chat_msg','chat_msg_del','new_bet','del_bet','player_extra']){
    liveCh.on('broadcast',{event},handleLiveNotice);
  }
  liveCh.subscribe(status=>{if(status==='SUBSCRIBED')scheduleSync()});
}


let view="g",cur=null,photo="";
const $=id=>document.getElementById(id),pitch=$("pitch");

// Helper para obtener todas las apuestas recibidas por un jugador (todas las categorías)
function getPlayerBets(name,playerId){
  if(!name) return { goals: 0, mvp: 0, defender: 0, keeper: 0, assist: 0, cards: 0, bloopers: 0, list: [] };
  const target = name.trim().toLowerCase();
  let goals = 0, mvp = 0, defender = 0, keeper = 0, assist = 0, cards = 0, bloopers = 0;
  const list = [];

  betsList.forEach(b => {
    const items = [];
    const checkMatch = (val,category) => {
      if(b.refs?.[category] && playerId)return b.refs[category]===playerId;
      return !!val && val.trim().toLowerCase()===target;
    };

    if(checkMatch(b.scorer,"scorer")){
      goals++;
      items.push(`⚽ Gol`);
    }
    if(checkMatch(b.mvp,"mvp")){
      mvp++;
      items.push(`👑 MVP`);
    }
    if(checkMatch(b.defender,"defender")){
      defender++;
      items.push(`🛡️ Muralla`);
    }
    if(checkMatch(b.keeper,"keeper")){
      keeper++;
      items.push(`🧤 Atajadón`);
    }
    if(checkMatch(b.assist,"assist")){
      assist++;
      items.push(`🪄 Asistencia/Caño`);
    }
    if(checkMatch(b.yellow_card,"yellow")){
      cards++;
      items.push(`🟨 Amarilla`);
    }
    if(checkMatch(b.blooper,"blooper")){
      bloopers++;
      items.push(`🥩 Paga Asado`);
    }

    if(items.length > 0){
      const s0 = b.s0 !== undefined ? b.s0 : (b.team_pick === "0" ? 2 : 1);
      const s1 = b.s1 !== undefined ? b.s1 : (b.team_pick === "1" ? 2 : 1);
      list.push({
        user: b.user,
        items,
        score: `${s0} - ${s1}`,
        chips: b.amount || 500
      });
    }
  });

  return { goals, mvp, defender, keeper, assist, cards, bloopers, list };
}

// Coordenadas cancha horizontal
const G=(t,i)=>{
  const[x,y]=V[i],d=(88-y)/74;
  const px=5+d*40;
  return t?[100-px,100-x]:[px,x];
};

function pl(t,i,x,y){
  const p=S[t][i],d=document.createElement("div");
  d.className=p.n?'p occupied':'p empty';
  d.style.cssText=`left:${x}%;top:${y}%;--c:${C[t]}`;
  const capHtml=p.c?`<span class="cap-badge" title="Capitán">C</span>`:"";

  // Badges de apuestas recibidas en la planilla
  const bData=getPlayerBets(p.n,p.id);
  let betsBadgeHtml="";
  if(bData.goals>0||bData.mvp>0||bData.defender>0||bData.keeper>0||bData.assist>0||bData.cards>0||bData.bloopers>0){
    const parts=[];
    if(bData.goals>0) parts.push(`⚽ ${bData.goals}`);
    if(bData.mvp>0) parts.push(`👑`);
    if(bData.defender>0) parts.push(`🛡️`);
    if(bData.keeper>0) parts.push(`🧤`);
    if(bData.assist>0) parts.push(`🪄`);
    if(bData.cards>0) parts.push(`🟨`);
    if(bData.bloopers>0) parts.push(`🥩`);
    betsBadgeHtml=`<div class="p-bets-badge" title="Pálpitos recibidos">${parts.join(" ")}</div>`;
  }

  d.innerHTML=`<div class="w">
    ${capHtml}
    ${betsBadgeHtml}
    <div class="av" ${p.f?`style="background-image:url(&quot;${escapeHtml(safePhoto(p.f))}&quot;)"`:""}>${p.f?'':p.n?escapeHtml(p.n.slice(0,2).toUpperCase()):'<span class="add-player">+</span>'}</div>
    <span class="pos">${POS[i]}</span>
  </div>
  <div class="nm ${p.n?"":"e"}">${escapeHtml(p.n)||"Libre"}</div>`;
  d.tabIndex=0;d.setAttribute('role','button');d.setAttribute('aria-label',`Equipo ${t+1}, ${PN[i]}: ${p.n||'lugar libre'}`);
  d.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openModal(t,i)}};
  d.onclick=()=>openModal(t,i);
  pitch.append(d);
}

function line(s){
  const l=document.createElement("div");
  l.className="ln";
  l.style.cssText=s;
  pitch.append(l);
}

function render(){
  pitch.innerHTML="";
  const pt=innerWidth<innerHeight;
  if(view=="g"&&pt){
    pitch.className="v g";
    line("left:0;right:0;top:50%;border-width:2px 0 0");
    line("left:50%;top:50%;width:26%;aspect-ratio:1;border-radius:50%;transform:translate(-50%,-50%)");
    line("left:22%;right:22%;bottom:0;height:12%");
    line("left:22%;right:22%;top:0;height:12%");
    pitch.insertAdjacentHTML("beforeend",`<span class="tag" style="left:8px;top:6px;color:var(--t2)">Equipo 2</span><span class="tag" style="left:8px;top:auto;bottom:6px;color:var(--t1)">Equipo 1</span>`);
    for(let t=0;t<2;t++)S[t].forEach((_,i)=>{
      const x=V[i][0],yy=[95,83,71,57][i?i<5?1:i<8?2:3:0];
      pl(t,i,t?100-x:x,t?100-yy:yy);
    });
  }else if(view=="g"){
    pitch.className="h g";
    line("left:50%;top:0;bottom:0;border-width:0 0 0 2px");
    line("left:50%;top:50%;width:18%;aspect-ratio:1;border-radius:50%;transform:translate(-50%,-50%)");
    [0,1].forEach(t=>{
      const s=t?"right":"left";
      line(`${s}:0;top:22%;height:56%;width:15%`);
      line(`${s}:0;top:36%;height:28%;width:5%`);
    });
    pitch.insertAdjacentHTML("beforeend",`<span class="tag" style="left:12px;color:var(--t1)">Equipo 1</span><span class="tag" style="right:12px;color:var(--t2)">Equipo 2</span>`);
    for(let t=0;t<2;t++)S[t].forEach((_,i)=>{
      const[x,y]=G(t,i);
      pl(t,i,x,y);
    });
  }else{
    const t=+view;
    pitch.className="v";
    line("left:0;right:0;top:50%;border-width:2px 0 0");
    line("left:50%;top:50%;width:26%;aspect-ratio:1;border-radius:50%;transform:translate(-50%,-50%)");
    line("left:22%;right:22%;bottom:0;height:16%");
    line("left:22%;right:22%;top:0;height:16%");
    pitch.insertAdjacentHTML("beforeend",`<span class="tag" style="left:0;right:0;top:auto;bottom:-34px;color:${C[t]}"></span>`);
    S[t].forEach((_,i)=>pl(t,i,V[i][0],V[i][1]));
  }

  renderBench();
  renderSummary();
  renderRoster();
}

// Render Banco de Suplentes & Árbitro
function renderBench(){
  [0,1].forEach(t=>{
    const cont=$(`bench-t${t}`);
    if(!cont)return;
    cont.innerHTML="";
    subs[t].forEach((p,idx)=>{
      const i=11+idx;
      const slot=document.createElement("div");
      slot.className="b-slot";
      slot.style.setProperty("--c",C[t]);
      const capHtml=p.c?`<span class="cap-badge" style="top:-4px;left:-4px" title="Capitán">C</span>`:"";

      // Badge de apuestas en suplentes
      const bData=getPlayerBets(p.n,p.id);
      let betsBadgeHtml="";
      if(bData.goals>0||bData.mvp>0||bData.defender>0||bData.keeper>0||bData.assist>0||bData.cards>0||bData.bloopers>0){
        const parts=[];
        if(bData.goals>0) parts.push(`⚽ ${bData.goals}`);
        if(bData.mvp>0) parts.push(`👑`);
        if(bData.defender>0) parts.push(`🛡️`);
        if(bData.keeper>0) parts.push(`🧤`);
        if(bData.assist>0) parts.push(`🪄`);
        if(bData.cards>0) parts.push(`🟨`);
        if(bData.bloopers>0) parts.push(`🥩`);
        betsBadgeHtml=`<div class="b-bets-badge" title="Pálpitos">${parts.join(" ")}</div>`;
      }

      slot.innerHTML=`
        <div class="b-slot-w">
          ${capHtml}
          ${betsBadgeHtml}
          <div class="b-slot-av" ${p.f?`style="background-image:url(&quot;${escapeHtml(safePhoto(p.f))}&quot;)"`:""}>${p.f?'':p.n?escapeHtml(p.n.slice(0,2).toUpperCase()):'+'}</div>
          <span class="b-slot-pos">SUP</span>
        </div>
        <div class="b-slot-nm ${p.n?"":"e"}">${escapeHtml(p.n)||`+ Sup ${idx+1}`}</div>
      `;
      slot.onclick=()=>openModal(t,i);
      cont.append(slot);
    });
  });

  // Árbitro slot con foto y asignación
  const refCont=$("slot-ref");
  if(refCont){
    refCont.innerHTML="";
    const slot=document.createElement("div");
    slot.className="b-slot";
    slot.style.setProperty("--c","var(--gold)");
    slot.style.width="90px";

    const wrapper=document.createElement("div");
    wrapper.className="b-slot-w";
    wrapper.style.width="50px";
    wrapper.style.height="50px";

    const av=document.createElement("div");
    av.className="b-slot-av";
    const safeRefPhoto=safePhoto(referee.f);
    if(safeRefPhoto){
      av.style.backgroundImage=`url(${JSON.stringify(safeRefPhoto)})`;
    }else{
      const icon=document.createElement("span");
      icon.style.fontSize="22px";
      icon.textContent="🟨";
      av.append(icon);
    }

    const pos=document.createElement("span");
    pos.className="b-slot-pos";
    pos.style.background="#ffd700";
    pos.style.color="#111";
    pos.textContent="REF";
    wrapper.append(av,pos);

    const nm=document.createElement("div");
    nm.className=`b-slot-nm ${referee.n?"":"e"}`;
    nm.style.maxWidth="100%";
    nm.textContent=referee.n||"+ Asignar Árbitro";

    slot.append(wrapper,nm);
    slot.onclick=()=>openModal(2,0);
    refCont.append(slot);
  }
}

// Abrir diálogo de edición de titular, suplente o árbitro
function openModal(t,i){
  cur=[t,i];
  const p=getSlotData(t,i);
  photo=p.f||"";

  // El árbitro siempre puede cargar/editar su foto y su nombre
  const mine = isMine(t,i);
  $("dlg").classList.toggle("ro",!mine);
  $("dlg").classList.toggle("is-ref",t===2);
  $("inp").disabled=!mine;
  $('player-access-note').textContent=mine?'Tu nombre y foto se guardan para todos.':'Solo el acceso que cargó este lugar puede editarlo. Recuperalo en “Mi acceso”.';
  setFeedback('player-error','');
  $('fb').disabled=!mine;$('save').disabled=!mine;
  $("inp").value=p.n||"";
  prev();

  const bBox = $("dlg-bets-box");

  if(t===2){
    // Árbitro
    $("dt").innerHTML="⚖️ ÁRBITRO OFICIAL<br><small style=\"color:var(--gold);font-size:11px\">Foto y nombre del referí oficial</small>";
    $("cap-box").style.display="none";
    $("lbl-pos").style.display="none";
    $("mv").style.display="none";
    if(bBox) bBox.style.display="none";
    $("dlg").style.setProperty("--gold","#f5c542");
    $("fb").style.display="inline-block";
    $("save").style.display="inline-block";
  }else{
    $("cap-box").style.display="flex";
    $("lbl-pos").style.display="block";
    $("mv").style.display="block";
    $("inp-cap").checked=!!p.c;
    $("inp-cap").disabled=!mine;

    const baseTitle=i>=11?`EQUIPO ${t+1} · SUPLENTE ${i-10}`:`EQUIPO ${t+1} · ${POS[i]}`;
    $("dt").innerHTML=baseTitle + (!mine?`<br><small style="color:var(--gold);font-size:11px">🔒 Lugar ocupado por ${escapeHtml(p.n||"otro jugador")}</small>`:"");

    // Llenar caja de apuestas de este jugador
    if(bBox){
      if(!p.n){
        bBox.style.display="none";
      }else{
        bBox.style.display="block";
        const bData = getPlayerBets(p.n,p.id);
        const tot = bData.list.length;
        $("dlg-bets-tot").textContent = tot;

        if(tot === 0){
          $("dlg-bets-summary").innerHTML = `<div class="player-bets-empty">Sin pálpitos todavía para este jugador.<br>¡Sé el primero en apostar por él en el Prode! 🎯</div>`;
          $("dlg-bets-details").innerHTML = "";
        }else{
          const parts = [];
          if(bData.goals > 0) parts.push(`<span class="bet-pill">⚽ ${bData.goals} ${bData.goals===1?'voto a Gol':'votos a Gol'}</span>`);
          if(bData.mvp > 0) parts.push(`<span class="bet-pill gold">👑 ${bData.mvp} ${bData.mvp===1?'voto a MVP':'votos a MVP'}</span>`);
          if(bData.defender > 0) parts.push(`<span class="bet-pill" style="border-color:#4fc3f7">🛡️ ${bData.defender} ${bData.defender===1?'voto Defensor':'votos Defensor'}</span>`);
          if(bData.keeper > 0) parts.push(`<span class="bet-pill" style="border-color:#81c784">🧤 ${bData.keeper} ${bData.keeper===1?'voto Arquero':'votos Arquero'}</span>`);
          if(bData.assist > 0) parts.push(`<span class="bet-pill" style="border-color:#ba68c8">🪄 ${bData.assist} ${bData.assist===1?'voto Asistencia':'votos Asistencia'}</span>`);
          if(bData.cards > 0) parts.push(`<span class="bet-pill">🟨 ${bData.cards} ${bData.cards===1?'voto a Amarilla':'votos a Amarilla'}</span>`);
          if(bData.bloopers > 0) parts.push(`<span class="bet-pill" style="color:#ff8888">🥩 ${bData.bloopers} ${bData.bloopers===1?'voto Paga Birras':'votos Paga Birras'}</span>`);
          $("dlg-bets-summary").innerHTML = parts.join(" ");

          let feed = "";
          bData.list.forEach(item => {
            feed += `
              <div class="player-bet-item">
                <div><b>${escapeHtml(item.user)}</b> apostó:</div>
                <div style="color:var(--gold);margin-top:2px">${item.items.join(" · ")}</div>
                <div style="font-size:10px;color:#777;margin-top:2px">Marcador: ${item.score} · 🪙 ${item.chips} pts</div>
              </div>
            `;
          });
          $("dlg-bets-details").innerHTML = feed;
        }
      }
    }

    // Opciones para mover / intercambiar posición
    let opts="";
    [0,1].forEach(k=>{
      opts+=`<optgroup label="Equipo ${k+1} - Titulares">`;
      PN.forEach((n,j)=>{
        const sel=(k===t&&j===i)?"selected":"";
        const dis=isMine(k,j)?"":"disabled";
        const name=S[k][j].n?` (${S[k][j].n})`:"";
        opts+=`<option value="${k}_${j}" ${sel} ${dis}>Eq ${k+1} · ${n}${escapeHtml(name)}</option>`;
      });
      opts+=`</optgroup><optgroup label="Equipo ${k+1} - Suplentes">`;
      for(let s=0;s<5;s++){
        const j=11+s;
        const sel=(k===t&&j===i)?"selected":"";
        const dis=isMine(k,j)?"":"disabled";
        const name=subs[k][s].n?` (${subs[k][s].n})`:"";
        opts+=`<option value="${k}_${j}" ${sel} ${dis}>Eq ${k+1} · Suplente ${s+1}${escapeHtml(name)}</option>`;
      }
      opts+=`</optgroup>`;
    });
    $("mv").innerHTML=opts;
    $("dlg").style.setProperty("--gold",t?"#ff3b4d":"#2d7dff");
  }

  $("dlg").showModal();
}

const prev=()=>$("pre").style.backgroundImage=photo?`url(${JSON.stringify(safePhoto(photo))})`:"none";

$('fb').onclick=()=>$('file').click();
$('file').onchange=e=>{
  const f=e.target.files[0];e.target.value='';
  if(!f)return;
  if(!f.type.startsWith('image/') || f.size>15*1024*1024){setFeedback('player-error','Elegí una imagen de hasta 15 MB.');return}
  const image=new Image(),url=URL.createObjectURL(f),editing=cur?.join('_');
  photoLoading=true;$('save').disabled=true;setFeedback('player-error','Preparando foto…');
  const done=()=>{URL.revokeObjectURL(url);photoLoading=false;$('save').disabled=false};
  image.onload=()=>{
    try{
      if(cur?.join('_')!==editing)return;
      const canvas=document.createElement('canvas'),size=canvas.width=canvas.height=320;
      const crop=Math.min(image.width,image.height);
      canvas.getContext('2d').drawImage(image,(image.width-crop)/2,(image.height-crop)/2,crop,crop,0,0,size,size);
      photo=canvas.toDataURL('image/jpeg',.85);prev();setFeedback('player-error','');
    }catch{setFeedback('player-error','No se pudo leer la foto. Probá con un JPG o PNG.')}finally{done()}
  };
  image.onerror=()=>{setFeedback('player-error','No se pudo leer la foto. Probá con un JPG o PNG.');done()};
  image.src=url;
};

async function uploadPhoto(f){
  if(!f.startsWith('data:'))return f;
  const blob=await (await fetch(f)).blob();
  const path=`${me}/${crypto.randomUUID()}.jpg`;
  const {error}=await db.storage.from('fotos').upload(path,blob,{contentType:'image/jpeg'});
  if(error)throw new Error('No se pudo subir la foto. '+backendError(error));
  return db.storage.from('fotos').getPublicUrl(path).data.publicUrl;
}
async function putPlayer(t,i,n,f,isCap){
  await requireShared('players');
  if(!isMine(t,i))throw new Error('Recuperá el acceso con el que cargaste este jugador.');
  const [t2,i2]=t===2?[2,0]:$('mv').value.split('_').map(Number);
  if(!isMine(t2,i2))throw new Error('El lugar de destino ya pertenece a otro jugador.');
  const uploaded=await uploadPhoto(f||'');
  const {data,error}=await db.rpc('save_centenario_player',{
    source_team:t,source_pos:i,target_team:t2,target_pos:i2,
    player_name:n,player_photo:uploaded||null,captain:!!isCap
  });
  if(error)throw new Error(backendError(error));
  if(!Array.isArray(data)||!data.length)throw new Error('La base no confirmó el cambio. Actualizá los datos y volvé a intentar.');
  stateRevision++;
  replacePlayers(data);refreshViews();rememberName(n);
  $('dlg').close();notifyUser('Jugador guardado para todos.');
  broadcast('player_extra',{team:t2,pos:i2});
}
$('save').onclick=async()=>{
  if($('save').disabled||photoLoading)return;
  const n=$('inp').value.trim().slice(0,20);
  if(!n){setFeedback('player-error','Ingresá un nombre para guardar.');$('inp').focus();return}
  $('save').disabled=true;$('save').textContent='Guardando…';setFeedback('player-error','');
  try{await putPlayer(cur[0],cur[1],n,photo,$('inp-cap').checked)}
  catch(error){setFeedback('player-error',error.message)}
  finally{$('save').disabled=false;$('save').textContent='Guardar'}
};

$("cls").onclick=()=>$("dlg").close();

document.querySelectorAll(".nav-group button[data-v]").forEach(b=>b.onclick=()=>{
  view=b.dataset.v;
  document.querySelectorAll(".nav-group button[data-v]").forEach(x=>(x.classList.toggle("on",x==b),x.setAttribute("aria-pressed",String(x===b))));
  render();
});

$("btn-bench").onclick=()=>{
  $("bench-section").scrollIntoView({behavior:"smooth",block:"start"});
};

// ==================== NOTITAS DE INSTAGRAM ====================
let currentNoteIndex=0;
let noteTimer=null;

function updateNote(forceFresh=false){
  if(!chatMessages.length){
    $("ig-note-author").textContent="Tribuna Centenario";
    $("ig-note-time").textContent="Ahora";
    $("ig-note-msg").textContent="¡Dejá tu notita acá para picantear el partido! 🔥";
    $("ig-note-av").innerHTML="⚽";
    $("ig-note-av").style.backgroundImage="none";
    return;
  }

  if(forceFresh)currentNoteIndex=chatMessages.length-1;
  else currentNoteIndex=(currentNoteIndex+1)%chatMessages.length;

  const msg=chatMessages[currentNoteIndex];
  if(!msg)return;

  const bubble=$("ig-note");
  bubble.style.animation="none";
  bubble.getBoundingClientRect(); // trigger reflow
  bubble.style.animation="notePop .35s cubic-bezier(0.175,0.885,0.32,1.275)";

  $("ig-note-author").textContent=msg.author;
  $("ig-note-time").textContent=formatRelativeTime(msg.time);
  $("ig-note-msg").textContent=msg.text;
  if(msg.photo){
    $("ig-note-av").style.backgroundImage=`url(${JSON.stringify(safePhoto(msg.photo))})`;
    $("ig-note-av").innerHTML="";
  }else{
    $("ig-note-av").style.backgroundImage="none";
    $("ig-note-av").textContent=msg.author.slice(0,2).toUpperCase();
  }
}

// Rotación automática de notitas cada 4.5 segundos
setInterval(()=>updateNote(false),4500);

$("ig-note").onclick=()=>openChatModal();

function formatRelativeTime(ts){
  if(!ts)return "Ahora";
  const diff=Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(diff<60)return "Ahora";
  if(diff<3600)return `hace ${Math.floor(diff/60)}m`;
  if(diff<86400)return `hace ${Math.floor(diff/3600)}h`;
  return "hace días";
}

// ==================== CHAT ====================
$("btn-chat").onclick=()=>openChatModal();
$("chat-cls").onclick=()=>$("dlg-chat").close();

function openChatModal(){
  // Autocompletar nombre con nombre guardado o de jugador
  const myName=rememberedName()||getMyClaimedPlayerName()||"";
  if(myName&&!$("chat-inp-name").value)$("chat-inp-name").value=myName;
  renderChat();
  $("dlg-chat").showModal();
  setTimeout(()=>{$("chat-feed").scrollTop=$("chat-feed").scrollHeight},50);
}

function getMyClaimedPlayerName(){
  for(let t=0;t<2;t++){
    for(let i=0;i<11;i++)if(S[t][i].o===me&&S[t][i].n)return S[t][i].n;
    for(let s=0;s<5;s++)if(subs[t][s].o===me&&subs[t][s].n)return subs[t][s].n;
  }
  return "";
}

function addEmoji(e){
  const inp=$("chat-inp-msg");
  inp.value+=e;
  inp.focus();
}

function renderChat(){
  const feed=$("chat-feed");
  if(!feed)return;
  feed.innerHTML="";
  if(!chatMessages.length){
    feed.innerHTML=`<div style="text-align:center;color:#777;padding:30px 10px;font-size:13px">Todavía no hay mensajes ni notitas.<br>¡Sé el primero en comentar algo picante! ⚽🔥</div>`;
    return;
  }

  $("chat-badge").textContent=chatMessages.length;
  $("chat-badge").style.display="inline-block";

  const adminActive=isAdmin();
  chatMessages.forEach(m=>{
    const item=document.createElement("div");
    const tClass=m.team===0?"t0":m.team===1?"t1":"t2";
    item.className=`chat-item ${tClass}`;
    const avHtml=m.photo?`<div class="chat-item-av" style="background-image:url(&quot;${escapeHtml(safePhoto(m.photo))}&quot;)"></div>`:`<div class="chat-item-av">${escapeHtml(m.author.slice(0,2).toUpperCase())}</div>`;
    const tagText=m.team===0?"Eq 1":m.team===1?"Eq 2":"Amigo";
    const delBtnHtml=adminActive?`<button type="button" class="chat-item-del-btn" data-del-id="${escapeHtml(m.id)}" title="Borrar mensaje (Admin)">🗑️</button>`:'';
    item.innerHTML=`
      ${avHtml}
      <div class="chat-item-body">
        <div class="chat-item-head">
          <span class="chat-item-user">${escapeHtml(m.author)}</span>
          <span class="chat-item-tag">${tagText}</span>
          <span class="chat-item-time">${formatRelativeTime(m.time)}</span>
          ${delBtnHtml}
        </div>
        <div class="chat-item-text">${escapeHtml(m.text)}</div>
      </div>
    `;
    feed.append(item);
  });

  feed.onclick=e=>{
    const btn=e.target.closest('.chat-item-del-btn');
    if(btn?.dataset.delId)void adminDeleteMessage(btn.dataset.delId);
  };
}

function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function sendChatMessage(){
  if($('chat-send').disabled)return;
  const author=$('chat-inp-name').value.trim().slice(0,20),text=$('chat-inp-msg').value.trim().slice(0,280);
  if(!author||!text){setFeedback('chat-feedback','Completá tu nombre y el mensaje.');return}
  $('chat-send').disabled=true;setFeedback('chat-feedback','');
  try{
    await requireShared('chat_messages');
    const player=getAllPlayers().find(p=>p.o===me&&p.n.toLowerCase()===author.toLowerCase());
    const newMsg={id:crypto.randomUUID(),author,team:player?.t??null,photo:player?.f||null,text,owner:me};
    const {data,error}=await db.from('chat_messages').insert(newMsg).select();
    if(error)throw new Error(backendError(error));
    if(!data?.length)throw new Error('No se confirmó el envío. Volvé a intentar.');
    stateRevision++;
    const saved=data[0];
    chatMessages=chatMessages.filter(m=>m.id!==saved.id);
    chatMessages.push({id:saved.id,author:saved.author,team:saved.team,photo:saved.photo,text:saved.text,time:saved.created_at,owner:saved.owner});
    chatMessages=chatMessages.slice(-50);saveChat();refreshViews();
    rememberName(author);$('chat-inp-msg').value='';
    broadcast('chat_msg',{id:newMsg.id});
    $('chat-feed').scrollTop=$('chat-feed').scrollHeight;
  }catch(error){setFeedback('chat-feedback',error.message)}
  finally{$('chat-send').disabled=false}
}

$("chat-send").onclick=sendChatMessage;
$("chat-inp-msg").onkeydown=e=>{if(e.key==="Enter")void sendChatMessage()};

// ==================== PANEL DE ADMINISTRADOR ====================
const ADMIN_USER="centenarioutn412";
const ADMIN_PASS="centenarioutn412";

function isAdmin(){
  try{
    return sessionStorage.getItem("f11_admin")==="true";
  }catch{
    return false;
  }
}

function updateAdminBadge(){
  const badge=$("admin-auth-badge");
  if(badge)badge.style.display=isAdmin()?"inline-block":"none";
}

function openAdminModal(){
  const logged=isAdmin();
  $("admin-login-view").style.display=logged?"none":"block";
  $("admin-dashboard-view").style.display=logged?"block":"none";
  setFeedback("admin-feedback","");
  setFeedback("admin-dash-feedback","");
  updateAdminBadge();
  if(logged){
    setAdminTab("chat");
    renderAdminDashboard();
  }else{
    $("admin-inp-user").value="";
    $("admin-inp-pass").value="";
    setTimeout(()=>$("admin-inp-user").focus(),50);
  }
  $("dlg-admin").showModal();
}

function setAdminTab(tab){
  $("admin-tab-chat").classList.toggle("on",tab==="chat");
  $("admin-tab-chat").setAttribute("aria-selected",String(tab==="chat"));
  $("admin-tab-players").classList.toggle("on",tab==="players");
  $("admin-tab-players").setAttribute("aria-selected",String(tab==="players"));
  $("admin-panel-chat").style.display=tab==="chat"?"block":"none";
  $("admin-panel-players").style.display=tab==="players"?"block":"none";
  if(tab==="players")renderAdminPlayers();
}

function loginAdmin(){
  const user=($("admin-inp-user").value||"").trim();
  const pass=($("admin-inp-pass").value||"").trim();
  if(user===ADMIN_USER && pass===ADMIN_PASS){
    try{sessionStorage.setItem("f11_admin","true")}catch{}
    $("admin-login-view").style.display="none";
    $("admin-dashboard-view").style.display="block";
    updateAdminBadge();
    renderChat();
    setAdminTab("chat");
    renderAdminDashboard();
    setFeedback("admin-feedback","");
  }else{
    setFeedback("admin-feedback","Usuario o contraseña incorrectos.");
  }
}

function logoutAdmin(){
  try{sessionStorage.removeItem("f11_admin")}catch{}
  $("admin-login-view").style.display="block";
  $("admin-dashboard-view").style.display="none";
  updateAdminBadge();
  renderChat();
  setFeedback("admin-feedback","");
}

function renderAdminDashboard(){
  const list=$("admin-chat-list");
  if(!list)return;
  list.innerHTML="";
  const total=chatMessages.length;
  $("admin-chat-count-label").textContent=`${total} mensaje${total===1?"":"s"} en el vestuario`;

  const query=($("admin-chat-search")?.value||"").trim().toLowerCase();
  const filtered=chatMessages.filter(m=>{
    if(!query)return true;
    return (m.author||"").toLowerCase().includes(query)||(m.text||"").toLowerCase().includes(query);
  });

  if(!filtered.length){
    list.innerHTML=`<div style="text-align:center;color:#899b82;padding:24px 10px;font-size:12px">${query?"No se encontraron mensajes con ese criterio.":"Todavía no hay mensajes en el chat."}</div>`;
    return;
  }

  const sorted=[...filtered].reverse();
  sorted.forEach(m=>{
    const card=document.createElement("div");
    card.className="admin-msg-card";
    const tagText=m.team===0?"Equipo 1":m.team===1?"Equipo 2":"Amigo";
    card.innerHTML=`
      <div class="admin-msg-info">
        <div class="admin-msg-top">
          <span class="admin-msg-author">${escapeHtml(m.author)}</span>
          <span class="admin-msg-team">${tagText}</span>
          <span class="admin-msg-time">${formatRelativeTime(m.time)}</span>
        </div>
        <div class="admin-msg-body">${escapeHtml(m.text)}</div>
      </div>
      <button type="button" class="btn-msg-del" data-del-id="${escapeHtml(m.id)}" title="Borrar este mensaje">🗑️ Borrar</button>
    `;
    list.append(card);
  });
}

// ---- Edición de jugadores desde el panel de admin ----
function getAllSlots(){
  const slots=[];
  for(let t=0;t<2;t++){
    for(let i=0;i<11;i++)slots.push({t,i,p:S[t][i],tag:`Equipo ${t+1} · ${POS[i]}`});
    for(let s=0;s<5;s++)slots.push({t,i:11+s,p:subs[t][s],tag:`Equipo ${t+1} · Suplente ${s+1}`});
  }
  slots.push({t:2,i:0,p:referee,tag:"Árbitro oficial"});
  return slots;
}

function renderAdminPlayers(){
  const list=$("admin-players-list");
  if(!list)return;
  const query=($("admin-players-search")?.value||"").trim().toLowerCase();
  const slots=getAllSlots().filter(({p})=>!query||(p.n||"").toLowerCase().includes(query));
  if(!slots.length){
    list.innerHTML=`<div style="text-align:center;color:#899b82;padding:24px 10px;font-size:12px">No se encontraron jugadores con ese criterio.</div>`;
    return;
  }
  list.innerHTML=slots.map(({t,i,p,tag})=>{
    const avatarStyle=p.f?`style="background-image:url(&quot;${escapeHtml(safePhoto(p.f))}&quot;)"`:"";
    const initials=p.f?"":(p.n?escapeHtml(p.n.slice(0,2).toUpperCase()):"+");
    return `<button type="button" class="admin-player-card" data-team="${t}" data-pos="${i}">
      <span class="admin-player-av" ${avatarStyle}>${initials}</span>
      <span class="admin-player-info">
        <span class="admin-player-name ${p.n?"":"e"}">${escapeHtml(p.n)||"Lugar libre"}${p.c?' <b style="color:var(--gold)">C</b>':""}</span>
        <span class="admin-player-tag">${tag}</span>
      </span>
      <span class="admin-player-arrow">✎</span>
    </button>`;
  }).join("");
  list.querySelectorAll(".admin-player-card").forEach(card=>{
    card.onclick=()=>openAdminPlayerModal(Number(card.dataset.team),Number(card.dataset.pos));
  });
}

let adminPlayerCur=null,adminPlayerPhoto="";

function openAdminPlayerModal(t,i){
  adminPlayerCur=[t,i];
  const p=getSlotData(t,i);
  adminPlayerPhoto=p.f||"";
  $("admin-player-pre").style.backgroundImage=adminPlayerPhoto?`url(${JSON.stringify(safePhoto(adminPlayerPhoto))})`:"none";
  $("admin-player-inp").value=p.n||"";
  setFeedback("admin-player-error","");

  if(t===2){
    $("admin-player-title").textContent="⚖️ Árbitro oficial";
    $("admin-player-lbl-pos").style.display="none";
    $("admin-player-mv").style.display="none";
  }else{
    const baseTitle=i>=11?`Equipo ${t+1} · Suplente ${i-10}`:`Equipo ${t+1} · ${POS[i]}`;
    $("admin-player-title").textContent=baseTitle;
    $("admin-player-lbl-pos").style.display="block";
    $("admin-player-mv").style.display="block";
    let opts="";
    [0,1].forEach(k=>{
      opts+=`<optgroup label="Equipo ${k+1} - Titulares">`;
      PN.forEach((n,j)=>{
        const sel=(k===t&&j===i)?"selected":"";
        const name=S[k][j].n?` (${S[k][j].n})`:"";
        opts+=`<option value="${k}_${j}" ${sel}>Eq ${k+1} · ${n}${escapeHtml(name)}</option>`;
      });
      opts+=`</optgroup><optgroup label="Equipo ${k+1} - Suplentes">`;
      for(let s=0;s<5;s++){
        const j=11+s;
        const sel=(k===t&&j===i)?"selected":"";
        const name=subs[k][s].n?` (${subs[k][s].n})`:"";
        opts+=`<option value="${k}_${j}" ${sel}>Eq ${k+1} · Suplente ${s+1}${escapeHtml(name)}</option>`;
      }
      opts+=`</optgroup>`;
    });
    $("admin-player-mv").innerHTML=opts;
  }

  $("dlg-admin-player").showModal();
}

$("admin-player-fb").onclick=()=>$("admin-player-file").click();
$("admin-player-file").onchange=e=>{
  const f=e.target.files[0];e.target.value="";
  if(!f)return;
  if(!f.type.startsWith("image/") || f.size>15*1024*1024){setFeedback("admin-player-error","Elegí una imagen de hasta 15 MB.");return}
  const image=new Image(),url=URL.createObjectURL(f),editing=adminPlayerCur?.join("_");
  $("admin-player-save").disabled=true;setFeedback("admin-player-error","Preparando foto…");
  const done=()=>{URL.revokeObjectURL(url);$("admin-player-save").disabled=false};
  image.onload=()=>{
    try{
      if(adminPlayerCur?.join("_")!==editing)return;
      const canvas=document.createElement("canvas"),size=canvas.width=canvas.height=320;
      const crop=Math.min(image.width,image.height);
      canvas.getContext("2d").drawImage(image,(image.width-crop)/2,(image.height-crop)/2,crop,crop,0,0,size,size);
      adminPlayerPhoto=canvas.toDataURL("image/jpeg",.85);
      $("admin-player-pre").style.backgroundImage=`url(${JSON.stringify(safePhoto(adminPlayerPhoto))})`;
      setFeedback("admin-player-error","");
    }catch{setFeedback("admin-player-error","No se pudo leer la foto. Probá con un JPG o PNG.")}finally{done()}
  };
  image.onerror=()=>{setFeedback("admin-player-error","No se pudo leer la foto. Probá con un JPG o PNG.");done()};
  image.src=url;
};

async function putPlayerAdmin(t,i,n,f){
  await requireShared("players");
  const [t2,i2]=t===2?[2,0]:$("admin-player-mv").value.split("_").map(Number);
  const uploaded=await uploadPhoto(f||"");
  const captain=(t===2)?false:!!getSlotData(t,i).c;
  const {data,error}=await db.rpc("admin_save_centenario_player",{
    admin_pass:ADMIN_PASS,source_team:t,source_pos:i,target_team:t2,target_pos:i2,
    player_name:n,player_photo:uploaded||null,captain
  });
  if(error)throw new Error(backendError(error));
  if(!Array.isArray(data)||!data.length)throw new Error("La base no confirmó el cambio. Actualizá los datos y volvé a intentar.");
  stateRevision++;
  replacePlayers(data);refreshViews();renderAdminPlayers();
  $("dlg-admin-player").close();notifyUser("Jugador actualizado por el admin.");
  broadcast("player_extra",{team:t2,pos:i2});
}

$("admin-player-save").onclick=async()=>{
  if($("admin-player-save").disabled)return;
  const n=$("admin-player-inp").value.trim().slice(0,20);
  if(!n){setFeedback("admin-player-error","Ingresá un nombre para guardar.");$("admin-player-inp").focus();return}
  $("admin-player-save").disabled=true;$("admin-player-save").textContent="Guardando…";setFeedback("admin-player-error","");
  try{await putPlayerAdmin(adminPlayerCur[0],adminPlayerCur[1],n,adminPlayerPhoto)}
  catch(error){setFeedback("admin-player-error",error.message)}
  finally{$("admin-player-save").disabled=false;$("admin-player-save").textContent="Guardar"}
};
$("admin-player-cls").onclick=()=>$("dlg-admin-player").close();
$("admin-player-close").onclick=()=>$("dlg-admin-player").close();

$("admin-tab-chat").onclick=()=>setAdminTab("chat");
$("admin-tab-players").onclick=()=>setAdminTab("players");
$("admin-players-search").oninput=renderAdminPlayers;

async function adminDeleteMessage(msgId){
  if(!isAdmin()||!msgId)return;
  setFeedback("admin-dash-feedback","Borrando mensaje…");
  try{
    let deleted=false;
    try{
      const {error}=await db.rpc("admin_delete_chat_message",{msg_id:msgId,admin_pass:ADMIN_PASS});
      if(!error)deleted=true;
    }catch{}
    if(!deleted && db){
      const {error}=await db.from("chat_messages").delete().eq("id",msgId);
      if(error && error.code!=="PGRST116")throw new Error(backendError(error));
    }
    chatMessages=chatMessages.filter(m=>m.id!==msgId);
    saveChat();
    refreshViews();
    renderAdminDashboard();
    broadcast("chat_msg_del",{id:msgId});
    setFeedback("admin-dash-feedback","Mensaje borrado con éxito.",true);
  }catch(error){
    setFeedback("admin-dash-feedback",error.message||"No se pudo borrar el mensaje.");
  }
}

async function adminDeleteAllMessages(){
  if(!isAdmin())return;
  if(!confirm("¿Estás seguro de que querés borrar TODOS los mensajes del vestuario?"))return;
  setFeedback("admin-dash-feedback","Borrando todos los mensajes…");
  try{
    let deleted=false;
    try{
      const {error}=await db.rpc("admin_delete_chat_message",{msg_id:null,admin_pass:ADMIN_PASS});
      if(!error)deleted=true;
    }catch{}
    if(!deleted && db){
      const {error}=await db.from("chat_messages").delete().neq("id","00000000-0000-0000-0000-000000000000");
      if(error)throw new Error(backendError(error));
    }
    chatMessages=[];
    saveChat();
    refreshViews();
    renderAdminDashboard();
    broadcast("chat_msg_del",{id:null});
    setFeedback("admin-dash-feedback","Todos los mensajes fueron borrados.",true);
  }catch(error){
    setFeedback("admin-dash-feedback",error.message||"No se pudieron borrar los mensajes.");
  }
}

$("btn-admin").onclick=openAdminModal;
const footerAdmin=$("btn-footer-admin");
if(footerAdmin)footerAdmin.onclick=openAdminModal;
$("admin-close").onclick=()=>$("dlg-admin").close();
$("admin-btn-login").onclick=()=>void loginAdmin();
$("admin-btn-logout").onclick=logoutAdmin;
$("admin-btn-clear-all").onclick=()=>void adminDeleteAllMessages();
$("admin-chat-search").oninput=renderAdminDashboard;
$("admin-inp-pass").onkeydown=e=>{if(e.key==="Enter")void loginAdmin()};
$("admin-inp-user").onkeydown=e=>{if(e.key==="Enter")$("admin-inp-pass").focus()};
$("admin-chat-list").onclick=e=>{
  const btn=e.target.closest(".btn-msg-del");
  if(btn?.dataset.delId)void adminDeleteMessage(btn.dataset.delId);
};

// ==================== APUESTAS & PRODE PERSONALIZADO ====================
$("btn-bets").onclick=()=>openBetsModal();
$("bets-cls").onclick=()=>$("dlg-bets").close();

let betScore0 = 2;
let betScore1 = 1;
let selectedBetChips = 500;

function chooseWinner(pick){
  if(pick === 0 || pick === "0"){
    if(betScore0 <= betScore1){
      betScore0 = Math.min(15,Math.max(betScore1 + 1, 2));
      if(betScore1>=15)betScore1=14;
    }
  }else if(pick === 1 || pick === "1"){
    if(betScore1 <= betScore0){
      betScore1 = Math.min(15,Math.max(betScore0 + 1, 2));
      if(betScore0>=15)betScore0=14;
    }
  }else if(pick === "emp"){
    betScore1 = betScore0;
  }
  $("score-val-0").textContent = betScore0;
  $("score-val-1").textContent = betScore1;
  updateScoreSummary();
  updateTicketPreview();
}

function chooseGoals(pick){
  const tot = betScore0 + betScore1;
  if(pick === "mas" && tot < 3){
    betScore0 = 2;
    betScore1 = 1;
  }else if(pick === "menos" && tot >= 3){
    betScore0 = 1;
    betScore1 = 0;
  }
  $("score-val-0").textContent = betScore0;
  $("score-val-1").textContent = betScore1;
  updateScoreSummary();
  updateTicketPreview();
}

function stepScore(team, delta){
  if(team===0){
    betScore0 = Math.max(0, Math.min(15, betScore0 + delta));
    $("score-val-0").textContent = betScore0;
  }else{
    betScore1 = Math.max(0, Math.min(15, betScore1 + delta));
    $("score-val-1").textContent = betScore1;
  }
  updateScoreSummary();
  updateTicketPreview();
}

function updateScoreSummary(){
  const winner = betScore0 > betScore1 ? "Gana Equipo 1" : betScore0 < betScore1 ? "Gana Equipo 2" : "Empate";
  const winnerPick = betScore0 > betScore1 ? "0" : betScore0 < betScore1 ? "1" : "emp";
  const tot = betScore0 + betScore1;
  const goalsPick = tot >= 3 ? "mas" : "menos";
  const goalsTag = tot >= 3 ? "+2.5 Goles (Lluvia de goles)" : "-2.5 Goles (Partido cerrado)";

  document.querySelectorAll("#bet-pick-team .toggle-btn").forEach(b => {
    b.classList.toggle("sel", b.dataset.pick == winnerPick);
  });
  document.querySelectorAll("#bet-pick-goals .toggle-btn").forEach(b => {
    b.classList.toggle("sel", b.dataset.pick == goalsPick);
  });

  $("score-summary-tag").textContent = `Pronóstico: ${winner} (${betScore0} - ${betScore1}) · ${goalsTag}`;
}

function setupBetFormListeners(){
  // Selector fichas
  document.querySelectorAll("#bet-pick-chips .chip-btn").forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll("#bet-pick-chips .chip-btn").forEach(b=>b.classList.remove("sel"));
      btn.classList.add("sel");
      selectedBetChips=Number(btn.dataset.val);
      updateTicketPreview();
    };
  });
}
setupBetFormListeners();

const STAT_CATEGORIES = [
  { id: "scorer", icon: "⚽", title: "4. Goleador del Partido", sub: "Quién mete los goles o abre el marcador", defaultVal: "Cualquiera" },
  { id: "mvp", icon: "👑", title: "5. Figura de la Cancha (MVP)", sub: "El crack y mejor jugador del partido", defaultVal: "Cualquiera" },
  { id: "defender", icon: "🛡️", title: "6. Mejor Defensor (Muralla)", sub: "El candado que corta todo y no pasa nadie", defaultVal: "Cualquiera" },
  { id: "keeper", icon: "🧤", title: "7. Mejor Arquero / Atajada Épica", sub: "La salvada heroica bajo los tres palos", defaultVal: "Cualquiera" },
  { id: "assist", icon: "🪄", title: "8. Mejor Asistencia / Caño", sub: "El pase gol milimétrico o la jugada de lujo", defaultVal: "Cualquiera" },
  { id: "yellow", icon: "🟨", title: "9. Tarjeta Amarilla (El más rústico)", sub: "La patada criminal o foul táctico", defaultVal: "Nadie" },
  { id: "blooper", icon: "🥩", title: "10. Paga el Asado / Blooper", sub: "El blooper o gol errado insólito", defaultVal: "Nadie" },
];

const statSelections = {
  scorer: "",
  mvp: "",
  defender: "",
  keeper: "",
  assist: "",
  yellow: "",
  blooper: ""
};

let currentPickerCatId = "scorer";
let currentPickerTab = "all";

function getTeamPlayers(t){
  return [...S[t].map((p,pos)=>({...p,t,pos})),...subs[t].map((p,i)=>({...p,t,pos:i+11}))]
    .filter(p=>typeof p.n==='string'&&p.n.trim()).map(p=>({...p,n:p.n.trim(),key:p.id||`${t}_${p.pos}`}));
}
function getAllPlayers(){return [...getTeamPlayers(0),...getTeamPlayers(1)]}
function getTeamPlayerNames(t){return getTeamPlayers(t).map(p=>p.n)}
const statRefs={};
function refreshBetNames(){
  const players=getAllPlayers();
  for(const bet of betsList){
    for(const [category,id] of Object.entries(bet.refs||{})){
      const player=players.find(p=>p.id===id);
      if(player)bet[category==='yellow'?'yellow_card':category]=player.n;
    }
  }
  for(const [category,id] of Object.entries(statRefs)){
    const player=players.find(p=>p.key===id);
    if(player)statSelections[category]=player.n;
  }
}

function setStatChoice(catId, playerName, teamIdx, playerId){
  if(playerId)statRefs[catId]=playerId;else delete statRefs[catId];
  statSelections[catId] = playerName || "";

  const card = $(`card-stat-${catId}`);
  const isDefault = !playerName || playerName.startsWith("Cualquiera") || playerName.startsWith("Nadie");

  const bName = $(`badge-name-${catId}`);
  const bDot = $(`badge-dot-${catId}`);
  if(bName){
    if(isDefault){
      bName.textContent = catId === 'yellow' || catId === 'blooper' ? 'Nadie' : 'Cualquiera';
    }else{
      bName.textContent = teamIdx === 0 ? `🔵 ${playerName}` : (teamIdx === 1 ? `🔴 ${playerName}` : playerName);
    }
  }
  if(bDot){
    bDot.textContent = isDefault ? '⚪' : (teamIdx === 0 ? '🔵' : (teamIdx === 1 ? '🔴' : '⭐'));
  }
  if(card){
    card.classList.toggle("has-selection", !isDefault);
    card.querySelectorAll(".stat-pill").forEach(p => {
      p.classList.toggle("sel", p.dataset.player === playerName);
    });
  }

  const sel = $(`bet-sel-${catId}`);
  if(sel) sel.value = playerName;

  updateTicketPreview();
}

function clearStatChoice(catId){
  setStatChoice(catId, catId === 'yellow' || catId === 'blooper' ? 'Nadie' : 'Cualquiera');
}

function renderAllStatPickers(){
  const container=$('stat-cards-container');if(!container)return;
  const players=getAllPlayers();
  container.innerHTML=STAT_CATEGORIES.map(cat=>{
    const current=statSelections[cat.id]||cat.defaultVal;
    const selected=statRefs[cat.id];
    return `<div class="stat-card ${selected?'has-selection':''}" id="card-stat-${cat.id}">
      <div class="stat-card-hdr"><div><div class="stat-card-title">${cat.icon} ${cat.title}</div><div class="stat-card-sub">${cat.sub}</div></div></div>
      <div class="stat-card-sel-row"><div class="stat-sel-badge"><span id="badge-dot-${cat.id}">${selected?'●':'○'}</span><span id="badge-name-${cat.id}">${escapeHtml(current)}</span></div>
      <div class="stat-sel-actions"><button type="button" class="btn-stat-clear" data-clear="${cat.id}" aria-label="Quitar selección de ${cat.title}">✕</button><button type="button" class="btn-stat-modal" data-search="${cat.id}">Buscar ↗</button></div></div>
      <div class="stat-chips-box">${[0,1].map(t=>`<div class="stat-team-row"><span class="stat-team-chip-lbl ${t?'t2':'t1'}">Eq ${t+1}</span><div class="stat-team-chips">${players.filter(p=>p.t===t).map(p=>`<button type="button" class="stat-pill ${t?'t2':'t1'} ${selected===p.key?'sel':''}" data-category="${cat.id}" data-player-id="${escapeHtml(p.key)}" data-player="${escapeHtml(p.n)}">${escapeHtml(p.n)}</button>`).join('')||'<span class="form-help">Sin jugadores anotados</span>'}</div></div>`).join('')}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-player-id]').forEach(button=>button.onclick=()=>{
    const p=players.find(p=>p.key===button.dataset.playerId);
    if(p){setStatChoice(button.dataset.category,p.n,p.t,p.key);renderAllStatPickers()}
  });
  container.querySelectorAll('[data-clear]').forEach(button=>button.onclick=()=>{clearStatChoice(button.dataset.clear);renderAllStatPickers()});
  container.querySelectorAll('[data-search]').forEach(button=>button.onclick=()=>openFullPlayerPicker(button.dataset.search));
}

function openFullPlayerPicker(catId){
  currentPickerCatId = catId;
  const cat = STAT_CATEGORIES.find(c => c.id === catId);
  if(!cat) return;

  $("picker-title").textContent = `${cat.icon} ${cat.title}`;
  $("picker-sub").textContent = cat.sub;
  $("picker-search-inp").value = "";
  setPickerTab("all");
  $("dlg-player-picker").showModal();
}

function setPickerTab(tab){
  currentPickerTab = tab;
  document.querySelectorAll("#dlg-player-picker .picker-tab").forEach(b => {
    b.classList.toggle("sel", b.dataset.tab === tab);
  });
  filterPickerPlayers();
}

function filterPickerPlayers(){
  const query=$('picker-search-inp').value.trim().toLocaleLowerCase();
  const players=getAllPlayers();$('picker-cnt-all').textContent=players.length;
  const filtered=players.filter(p=>(currentPickerTab==='all'||String(p.t)===currentPickerTab)&&p.n.toLocaleLowerCase().includes(query));
  const list=$('picker-list');
  list.innerHTML=filtered.map(p=>`<button type="button" class="picker-item ${p.t?'t2':'t1'}" data-player-id="${escapeHtml(p.key)}"><span class="picker-item-name">${p.t?'🔴':'🔵'} ${escapeHtml(p.n)}</span><span class="picker-item-tag">${p.pos>=11?'SUP':POS[p.pos]} · Equipo ${p.t+1}</span></button>`).join('')||'<p class="form-help">No hay jugadores que coincidan. Anotalos primero en la cancha.</p>';
  list.querySelectorAll('[data-player-id]').forEach(button=>button.onclick=()=>{
    const p=players.find(p=>p.key===button.dataset.playerId);
    if(p){setStatChoice(currentPickerCatId,p.n,p.t,p.key);renderAllStatPickers();$('dlg-player-picker').close()}
  });
}

function selectPickerPlayer(name='',teamIdx,playerId){
  setStatChoice(currentPickerCatId,name,teamIdx,playerId);
  renderAllStatPickers();$('dlg-player-picker').close();
}

function updateTicketPreview(){
  const sTag = $("ticket-score");
  if(sTag) sTag.textContent = `Eq 1 [${betScore0}] - [${betScore1}] Eq 2`;

  const goalsTag = $("ticket-goals");
  const tot = betScore0 + betScore1;
  if(goalsTag) goalsTag.textContent = tot >= 3 ? "+2.5 Goles 🔥" : "-2.5 Goles 🛡️";

  const setRow = (id, val, def) => {
    const el = $(`ticket-${id}`);
    if(el) el.textContent = val || def;
  };

  setRow("scorer", statSelections.scorer, "Cualquiera");
  setRow("mvp", statSelections.mvp, "Cualquiera");
  setRow("defender", statSelections.defender, "Cualquiera");
  setRow("keeper", statSelections.keeper, "Cualquiera");
  setRow("assist", statSelections.assist, "Cualquiera");
  setRow("yellow", statSelections.yellow, "Nadie");
  setRow("blooper", statSelections.blooper, "Nadie");

  const cTag = $("ticket-chips");
  if(cTag) cTag.textContent = `🪙 ${selectedBetChips} pts`;
}

function openBetsModal(){
  const myName = rememberedName() || getMyClaimedPlayerName() || "";
  if(myName) $("bet-inp-user").value = myName;

  // Reconocer rol
  const bannerName = $("bet-profile-name");
  const bannerTag = $("bet-profile-tag");
  if(myName){
    bannerName.textContent = myName;
    const isT0 = S[0].some(x=>x.n&&x.n.toLowerCase()===myName.toLowerCase()) || subs[0].some(x=>x.n&&x.n.toLowerCase()===myName.toLowerCase());
    const isT1 = S[1].some(x=>x.n&&x.n.toLowerCase()===myName.toLowerCase()) || subs[1].some(x=>x.n&&x.n.toLowerCase()===myName.toLowerCase());
    if(isT0){
      bannerTag.textContent = "🔵 EQUIPO 1";
      bannerTag.style.background = "var(--t1)";
      bannerTag.style.color = "#fff";
    }else if(isT1){
      bannerTag.textContent = "🔴 EQUIPO 2";
      bannerTag.style.background = "var(--t2)";
      bannerTag.style.color = "#fff";
    }else{
      bannerTag.textContent = "⚽ ESPECTADOR";
      bannerTag.style.background = "#333";
      bannerTag.style.color = "#ccc";
    }
  }else{
    bannerName.textContent = "Amigo Invitado";
    bannerTag.textContent = "⚽ HINCHADA";
  }

  const existing=betsList.find(b=>me&&b.owner===me);
  if(existing){
    betScore0=existing.s0;betScore1=existing.s1;selectedBetChips=existing.amount;
    for(const cat of STAT_CATEGORIES){
      statSelections[cat.id]=existing[cat.id==='yellow'?'yellow_card':cat.id]||'';
      if(existing.refs[cat.id])statRefs[cat.id]=existing.refs[cat.id];else delete statRefs[cat.id];
    }
  }
  $('score-val-0').textContent=betScore0;$('score-val-1').textContent=betScore1;
  document.querySelectorAll('#bet-pick-chips .chip-btn').forEach(b=>b.classList.toggle('sel',Number(b.dataset.val)===selectedBetChips));
  setFeedback('bet-feedback','');
  // Llenar selectores visuales garantizados
  renderAllStatPickers();
  updateScoreSummary();
  updateTicketPreview();
  renderBets();
  $("dlg-bets").showModal();
}

function renderBets(){
  const total = betsList.length;
  $("bets-badge").textContent = total;
  $("bets-count").textContent = total;

  const list = $("bets-list");
  list.innerHTML = "";

  if(!total){
    list.innerHTML = `<div style="text-align:center;color:#777;padding:16px;font-size:12px">Todavía nadie cargó su boleta.<br>¡Armá tu pronóstico y mostrale a los pibes quién sabe de fútbol! 🎯</div>`;
    updateBetsOdds(0,0,0,0,{},{},{},{},{},{},{});
    return;
  }

  let t1Votes = 0, empVotes = 0, t2Votes = 0;
  let totalChips = 0;
  const [scorersCount,mvpsCount,defendersCount,keepersCount,assistsCount,cardsCount,bloopersCount,scoreCount]=Array.from({length:8},()=>Object.create(null));

  betsList.forEach(b => {
    totalChips += (b.amount || 500);

    const s0 = b.s0 !== undefined ? b.s0 : (b.team_pick === "0" ? 2 : (b.team_pick === "1" ? 0 : 1));
    const s1 = b.s1 !== undefined ? b.s1 : (b.team_pick === "1" ? 2 : (b.team_pick === "0" ? 0 : 1));

    if(s0 > s1) t1Votes++;
    else if(s0 < s1) t2Votes++;
    else empVotes++;

    const scoreKey = `${s0} - ${s1}`;
    scoreCount[scoreKey] = (scoreCount[scoreKey] || 0) + 1;

    const countStat = (map, val) => {
      if(val && !val.startsWith("Cualquiera") && !val.startsWith("Nadie") && !val.startsWith("Otro")){
        map[val] = (map[val] || 0) + 1;
      }
    };

    countStat(scorersCount, b.scorer);
    countStat(mvpsCount, b.mvp);
    countStat(defendersCount, b.defender);
    countStat(keepersCount, b.keeper);
    countStat(assistsCount, b.assist);
    countStat(cardsCount, b.yellow_card);
    countStat(bloopersCount, b.blooper);

    // Render tarjeta de apuesta
    const card = document.createElement("div");
    card.className = "bet-card";
    const isMineBet = !!me && b.owner === me;

    const winnerText = s0 > s1 ? "🔵 Gana Eq 1" : s0 < s1 ? "🔴 Gana Eq 2" : "🤝 Empate";

    card.innerHTML = `
      <div class="bet-card-head">
        <div class="bet-card-user">
          <span>⚽ ${escapeHtml(b.user)}</span>
          <span style="font-size:10px;color:#888">${formatRelativeTime(b.time)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="bet-card-score">${s0} - ${s1}</span>
          <span class="bet-pill gold" style="font-weight:900">🪙 ${b.amount || 500} pts</span>
        </div>
      </div>
      <div class="bet-card-details">
        <span class="bet-pill">${winnerText}</span>
        ${b.scorer && !b.scorer.startsWith("Cualquiera") ? `<span class="bet-pill">⚽ Gol: ${escapeHtml(b.scorer)}</span>` : ""}
        ${b.mvp && !b.mvp.startsWith("Cualquiera") ? `<span class="bet-pill gold">👑 MVP: ${escapeHtml(b.mvp)}</span>` : ""}
        ${b.defender && !b.defender.startsWith("Cualquiera") ? `<span class="bet-pill" style="border-color:#4fc3f7">🛡️ Defensor: ${escapeHtml(b.defender)}</span>` : ""}
        ${b.keeper && !b.keeper.startsWith("Cualquiera") ? `<span class="bet-pill" style="border-color:#81c784">🧤 Arquero: ${escapeHtml(b.keeper)}</span>` : ""}
        ${b.assist && !b.assist.startsWith("Cualquiera") ? `<span class="bet-pill" style="border-color:#ba68c8">🪄 Asistencia: ${escapeHtml(b.assist)}</span>` : ""}
        ${b.yellow_card && !b.yellow_card.startsWith("Nadie") ? `<span class="bet-pill">🟨 Amarilla: ${escapeHtml(b.yellow_card)}</span>` : ""}
        ${b.blooper && !b.blooper.startsWith("Nadie") ? `<span class="bet-pill" style="border-color:#ff555544;color:#ff8888">🥩 Paga birras: ${escapeHtml(b.blooper)}</span>` : ""}
      </div>
      <div class="bet-actions">
        <button type="button" class="btn-wa" onclick="shareBetWhatsApp('${b.id}')" title="Copiar pronóstico para WhatsApp">
          <span>📲 Compartir WhatsApp</span>
        </button>
        ${isMineBet ? `<button type="button" class="bet-del" onclick="deleteBet('${b.id}')" title="Borrar mi boleta">🗑️</button>` : ""}
      </div>
    `;
    list.append(card);
  });

  updateBetsOdds(t1Votes, empVotes, t2Votes, totalChips, scorersCount, mvpsCount, defendersCount, keepersCount, assistsCount, cardsCount, bloopersCount, scoreCount);
}

function getTopKey(obj){
  let top = "-", max = 0;
  for(const[k,v] of Object.entries(obj)){
    if(v > max){ max = v; top = `${k} (${v})`; }
  }
  return top;
}

function updateBetsOdds(t1, emp, t2, chips, scorers, mvps, defenders, keepers, assists, cards, bloopers, scores){
  const totalVotes = t1 + emp + t2;
  const p1 = totalVotes ? Math.round((t1/totalVotes)*100) : 33;
  const pe = totalVotes ? Math.round((emp/totalVotes)*100) : 34;
  const p2 = totalVotes ? Math.round((t2/totalVotes)*100) : 33;

  const bar = $("odds-bar");
  bar.innerHTML = `
    <div class="odds-t1" style="width:${p1}%">Eq 1 (${p1}%)</div>
    <div class="odds-emp" style="width:${pe}%">Emp (${pe}%)</div>
    <div class="odds-t2" style="width:${p2}%">Eq 2 (${p2}%)</div>
  `;

  $("stat-scorer").textContent = getTopKey(scorers);
  $("stat-mvp").textContent = getTopKey(mvps);
  if($("stat-defender")) $("stat-defender").textContent = getTopKey(defenders);
  if($("stat-keeper")) $("stat-keeper").textContent = getTopKey(keepers);
  if($("stat-assist")) $("stat-assist").textContent = getTopKey(assists);
  $("stat-card").textContent = getTopKey(cards);
  $("stat-blooper").textContent = getTopKey(bloopers);

  // Marcador más votado
  $("stat-fav-score").textContent = scores ? getTopKey(scores) : "-";
  $("stat-chips").textContent = chips.toLocaleString() + " pts";
}

$('bet-btn-submit').onclick=async()=>{
  const button=$('bet-btn-submit');if(button.disabled)return;
  const user=$('bet-inp-user').value.trim().slice(0,20);
  if(!user){setFeedback('bet-feedback','Ingresá tu nombre o apodo.');$('bet-inp-user').focus();return}
  button.disabled=true;button.textContent='Guardando…';setFeedback('bet-feedback','');
  try{
    await requireShared('bets');
    const players=getAllPlayers();
    for(const category of STAT_CATEGORIES){
      const id=statRefs[category.id];
      if(id&&!players.some(p=>p.key===id))throw new Error('Un jugador elegido ya no está en el plantel. Volvé a seleccionarlo.');
    }
    const extra={s0:betScore0,s1:betScore1,pick:betScore0>betScore1?'0':betScore0<betScore1?'1':'emp',
      mvp:statSelections.mvp,defender:statSelections.defender,keeper:statSelections.keeper,
      assist:statSelections.assist,blooper:statSelections.blooper,
      refs:Object.fromEntries(Object.entries(statRefs).filter(([,id])=>players.some(p=>p.id===id)))};
    const id=betsList.find(b=>b.owner===me)?.id||crypto.randomUUID();
    const {data,error}=await db.rpc('save_centenario_bet',{
      bet_id:id,user_label:user,prediction:JSON.stringify(extra),
      goals:betScore0+betScore1>=3?'mas':'menos',
      scorer_name:statSelections.scorer||'',yellow_name:statSelections.yellow||'',chips:selectedBetChips
    });
    if(error)throw new Error(backendError(error));
    if(!data?.length)throw new Error('No se confirmó tu boleta. Volvé a intentar.');
    stateRevision++;
    const saved=mapBetRow(data[0]);betsList=betsList.filter(b=>b.owner!==me);betsList.unshift(saved);
    rememberName(user);saveBets();refreshViews();broadcast('new_bet',{id:saved.id});
    setFeedback('bet-feedback','Pronóstico guardado para todos. Podés compartirlo desde tu boleta.',true);
    notifyUser('Tu pronóstico está guardado.');
  }catch(error){setFeedback('bet-feedback',error.message)}
  finally{button.disabled=false;button.textContent='Guardar mi pronóstico ↗'}
};

window.shareBetWhatsApp=(id)=>{
  const b = betsList.find(x => x.id === id);
  if(!b) return;

  const s0 = b.s0 !== undefined ? b.s0 : (b.team_pick === "0" ? 2 : 1);
  const s1 = b.s1 !== undefined ? b.s1 : (b.team_pick === "1" ? 2 : 1);
  const goalsTag = (s0 + s1) >= 3 ? "+2.5 Goles 🔥" : "-2.5 Goles 🛡️";

  const text = `🏆 *MI PRODE CENTENARIO - ${b.user}* ⚽🔥\n` +
    `🏟️ Resultado: 🔵 Eq 1 [ ${s0} ] - [ ${s1} ] Eq 2 🔴 (${goalsTag})\n` +
    (b.scorer && !b.scorer.startsWith("Cualquiera") ? `⚽ Goleador: ${b.scorer}\n` : "") +
    (b.mvp && !b.mvp.startsWith("Cualquiera") ? `👑 MVP: ${b.mvp}\n` : "") +
    (b.defender && !b.defender.startsWith("Cualquiera") ? `🛡️ Mejor Defensor: ${b.defender}\n` : "") +
    (b.keeper && !b.keeper.startsWith("Cualquiera") ? `🧤 Mejor Arquero: ${b.keeper}\n` : "") +
    (b.assist && !b.assist.startsWith("Cualquiera") ? `🪄 Asistencia / Caño: ${b.assist}\n` : "") +
    (b.yellow_card && !b.yellow_card.startsWith("Nadie") ? `🟨 Amarilla: ${b.yellow_card}\n` : "") +
    (b.blooper && !b.blooper.startsWith("Nadie") ? `🥩 Paga Asado/Blooper: ${b.blooper}\n` : "") +
    `🪙 Fichas en juego: ${b.amount || 500} pts\n` +
    `¿Quién se anima a ganarme? ¡Armá el tuyo! 🎯👇`;

  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>{
      alert("¡Pronóstico copiado al portapapeles! 📲\nPegalo en el grupo de WhatsApp de los pibes.");
    }).catch(()=>{
      prompt("Copia tu pronóstico para WhatsApp:", text);
    });
  }else{
    prompt("Copia tu pronóstico para WhatsApp:", text);
  }
};

const deletingBets=new Set();
window.deleteBet=async(id)=>{
  const bet=betsList.find(b=>b.id===id);
  if(!bet||!me||bet.owner!==me||deletingBets.has(id))return;
  if(!confirm('¿Eliminar tu boleta de pronóstico?'))return;
  deletingBets.add(id);
  try{
    await requireShared('bets');
    const {data,error}=await db.from('bets').delete().eq('id',id).eq('owner',me).select();
    if(error)throw new Error(backendError(error));
    if(!data?.length)throw new Error('No se confirmó el borrado. Actualizá los datos y volvé a intentar.');
    stateRevision++;
    betsList=betsList.filter(b=>b.id!==id);saveBets();refreshViews();broadcast('del_bet',{id});
    notifyUser('Boleta eliminada.');
  }catch(error){setFeedback('bet-feedback',error.message)}
  finally{deletingBets.delete(id)}
};

// Controles comunes. Solo el clic fuera del rectángulo cierra el diálogo.
document.querySelectorAll('dialog').forEach(dialog=>{
  dialog.addEventListener('click',event=>{
    const r=dialog.getBoundingClientRect();
    if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))dialog.close();
  });
});
$('sync-status').onclick=()=>sync();
function openAccess(){setFeedback('access-feedback','');$('access-code').value='';$('dlg-access').showModal()}
$('btn-access').onclick=openAccess;$('btn-access-hint').onclick=openAccess;
$('access-close').onclick=()=>$('dlg-access').close();
async function copyText(text){
  try{await navigator.clipboard.writeText(text);return true}catch{return false}
}
$('btn-invite').onclick=async()=>{
  const url=new URL(location.href);url.search='';url.hash='';
  if(await copyText(url.href))notifyUser('Enlace copiado. Pegalo en el grupo.');
  else prompt('Copiá el enlace del partido:',url.href);
};
$('access-copy').onclick=async()=>{
  try{
    await identityReady;
    if(await copyText('f11:'+tok))setFeedback('access-feedback','Código copiado. Guardalo en privado: permite editar tus datos.',true);
    else prompt('Guardá este código en privado:','f11:'+tok);
  }catch(error){setFeedback('access-feedback',error.message)}
};
$('access-restore').onclick=()=>{
  const token=$('access-code').value.trim().replace(/^f11:/,'');
  if(!/^[a-zA-Z0-9._-]{16,200}$/.test(token)){setFeedback('access-feedback','Pegá el código completo que copiaste en el otro navegador.');return}
  try{localStorage.setItem('f11tok',token);location.reload()}
  catch{setFeedback('access-feedback','Este navegador no permite guardar el acceso. Habilitá el almacenamiento del sitio.')}
};
function renderSummary(){
  const counts=S.map(team=>team.filter(p=>p.n).length),total=counts[0]+counts[1];
  $('match-count').textContent=`${total} / 22 titulares`;
  $('match-spaces').textContent=total===22?'¡Los dos equipos están completos!':`${22-total} ${total===21?'lugar disponible':'lugares disponibles'} en cancha`;
  counts.forEach((count,t)=>{$(`team-count-${t}`).textContent=`${count} / 11`;$(`team-progress-${t}`).value=count});
  const benchCount=subs.flat().filter(p=>p.n).length;
  $('squad-summary').textContent=`${benchCount} suplentes anotados · ${referee.n?'Árbitro confirmado':'Falta definir árbitro'}`;
}
function renderRoster(){
  const list=$('roster-list');
  list.innerHTML=[0,1].map(t=>`<div class="roster-team"><h3><i class="team-dot ${t?'red':'blue'}"></i> Equipo ${t+1}<span>${S[t].filter(p=>p.n).length} titulares</span></h3>${S[t].map((p,pos)=>`<button type="button" class="roster-player ${p.n?'':'empty'}" data-team="${t}" data-pos="${pos}"><span class="roster-number">${String(pos+1).padStart(2,'0')}</span><span class="roster-avatar" data-team="${t}" data-pos="${pos}">${p.f?'':escapeHtml(p.n?p.n.slice(0,2).toUpperCase():'+')}</span><span class="roster-name">${escapeHtml(p.n)||'Lugar disponible'}${p.c?' <b class="roster-captain">C</b>':''}</span><span class="roster-position">${POS[pos]}</span><span class="roster-arrow">↗</span></button>`).join('')}</div>`).join('');
  list.querySelectorAll('.roster-player').forEach(button=>button.onclick=()=>openModal(Number(button.dataset.team),Number(button.dataset.pos)));
  list.querySelectorAll('.roster-avatar').forEach(avatar=>{
    const p=S[Number(avatar.dataset.team)][Number(avatar.dataset.pos)];
    if(p.f)avatar.style.backgroundImage=`url(${JSON.stringify(safePhoto(p.f))})`;
  });
}
function safePhoto(photo){
  return typeof photo==='string'&&(/^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/i.test(photo))?photo:'';
}
betsList=canonicalBets(betsList);
refreshViews();
addEventListener('resize',()=>{if(!$('dlg').open)render()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync()});
addEventListener('online',()=>void sync());
addEventListener('offline',()=>connectionStatus('Sin conexión',true));
setInterval(()=>{if(!document.hidden)void sync()},20000);
identityReady.then(()=>{render();renderBets();startRealtime();void sync();}).catch(error=>connectionStatus('Acceso no disponible',true,error.message));
