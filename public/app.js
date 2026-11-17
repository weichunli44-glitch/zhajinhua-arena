const socket=io();
const $=id=>document.getElementById(id);
let state=null, roomCode=null, myId=null, isHost=false;
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function name(){return $('name').value.trim().slice(0,12)||'玩家'}
function enterLobby(){ $('lobby').hidden=false;$('game').hidden=true;state=null;roomCode=null; }
socket.on('connect',()=>{$('conn').textContent='服务器已连接';$('conn').style.color='#a8d68b';myId=socket.id});
socket.on('disconnect',()=>{$('conn').textContent='连接中断，正在重连…';$('conn').style.color='#e5a16d'});
socket.on('joined',data=>{roomCode=data.code;isHost=data.host;$('lobby').hidden=true;$('game').hidden=false;$('room').textContent=roomCode;toast('已进入房间 '+roomCode)});
socket.on('state',s=>{state=s;render()});
socket.on('notice',toast);socket.on('errorMsg',toast);
function render(){
 if(!state)return;
 $('room').textContent=state.code;$('pot').textContent=state.pot;$('bet').textContent=state.currentBet;
 $('players').innerHTML=state.players.map(p=>`<div class="player ${p.isYou?'you':''}"><b>${esc(p.name)}${p.isYou?'（你）':''}</b><br>${p.folded?'已弃牌':p.stack+' 筹码'}<br>${p.ready?'已加入':''}</div>`).join('');
 $('roomMessage').textContent=state.players.length+'/3 人 · '+(state.status==='waiting'?'等待开局':state.status==='playing'?'牌局进行中':'本局已结束');
 $('start').hidden=!(isHost&&state.players.length===3&&state.status!=='playing');
 $('start').textContent=state.status==='showdown'?'房主开始下一局':'房主开始发牌';
 $('opponents').innerHTML=state.players.filter(p=>!p.isYou).map(p=>`<div class="opponent"><b>${esc(p.name)}</b> · ${p.folded?'已弃牌':p.cards?handName(p.cards):'暗牌'}<div class="cards">${p.cards?p.cards.map(cardHTML).join(''):'<span class="back">♛</span><span class="back">♛</span><span class="back">♛</span>'}</div></div>`).join('');
 $('myCards').innerHTML=state.myCards?state.myCards.map(cardHTML).join(''):'<span class="back">?</span><span class="back">?</span><span class="back">?</span>';
 const mine=state.players.find(p=>p.isYou);
 $('myInfo').textContent=mine?(mine.folded?'你已弃牌':'你的筹码：'+mine.stack):'';
 const current=state.players.find(p=>p.id===state.turnId);
 $('turn').textContent=current?current.name:'—';$('gameMessage').textContent=state.message||'';
 const myTurn=state.status==='playing'&&state.turnId===socket.id&&!mine.folded;
 ['call','raise','compare','fold'].forEach(id=>$(id).disabled=!myTurn);
 const targets=state.players.filter(p=>!p.isYou&&!p.folded);
 $('target').innerHTML=targets.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
 $('target').hidden=!(myTurn&&targets.length);$('targetLabel').hidden=$('target').hidden;
 $('again').hidden=state.status!=='showdown'||!isHost;
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cardHTML(c){let rank=c.rank===14?'A':c.rank===13?'K':c.rank===12?'Q':c.rank===11?'J':c.rank;return `<span class="card ${'♥♦'.includes(c.suit)?'red':''}">${rank}${c.suit}</span>`}
function handName(cards){if(!cards)return '';const v=cards.map(c=>c.rank).sort((a,b)=>b-a),flush=cards.every(c=>c.suit===cards[0].suit),straight=(v[0]-v[2]===2&&new Set(v).size===3)||(v[0]===14&&v[1]===3&&v[2]===2);let cnt={};v.forEach(x=>cnt[x]=(cnt[x]||0)+1);if(Object.values(cnt).includes(3))return'豹子';if(straight&&flush)return'顺金';if(flush)return'金花';if(straight)return'顺子';if(Object.values(cnt).includes(2))return'对子';return'单张'}
$('create').onclick=()=>socket.emit('createRoom',{name:name()});
$('join').onclick=()=>socket.emit('joinRoom',{code:$('roomCode').value,name:name()});
$('match').onclick=()=>socket.emit('quickMatch',{name:name()});
$('start').onclick=()=>socket.emit('startGame');
$('again').onclick=()=>socket.emit('startGame');
$('call').onclick=()=>socket.emit('action',{type:'call'});
$('raise').onclick=()=>socket.emit('action',{type:'raise'});
$('fold').onclick=()=>socket.emit('action',{type:'fold'});
$('compare').onclick=()=>socket.emit('action',{type:'compare',targetId:$('target').value});
$('leave').onclick=()=>{socket.emit('leaveRoom');enterLobby()};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);toast('房间号已复制')}catch(e){toast('房间号：'+roomCode)}};
