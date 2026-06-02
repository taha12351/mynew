'use strict';

// ─── Board representation ───────────────────────────────────────────────────
// board[rank][file]  rank 0 = rank-8 (black back), rank 7 = rank-1 (white back)
// file 0 = file-a … file 7 = file-h
// Piece strings: 'wP','wN','wB','wR','wQ','wK','bP' … or null

function initBoard(){
  const b = Array(8).fill(null).map(()=>Array(8).fill(null));
  const back = ['R','N','B','Q','K','B','N','R'];
  for(let f=0;f<8;f++){
    b[0][f]='b'+back[f]; b[1][f]='bP';
    b[6][f]='wP';        b[7][f]='w'+back[f];
  }
  return b;
}
function cloneBoard(b){ return b.map(r=>[...r]); }
function col(p){ return p?p[0]:null; }
function typ(p){ return p?p[1]:null; }
function opp(c){ return c==='w'?'b':'w'; }

// ─── Square helpers ─────────────────────────────────────────────────────────
function squareToRC(sq){
  const f=sq.charCodeAt(0)-97;
  const r=8-parseInt(sq[1]);
  return [r,f];
}
function rcToSquare(r,f){ return String.fromCharCode(97+f)+(8-r); }

// ─── Pseudo-legal moves (don't filter self-check) ───────────────────────────
function pseudoMoves(board, rank, file, enPassant){
  const piece=board[rank][file];
  if(!piece) return [];
  const c=col(piece), t=typ(piece);
  const moves=[];

  function push(r,f,special){
    if(r<0||r>7||f<0||f>7) return;
    const tgt=board[r][f];
    if(tgt&&col(tgt)===c) return;
    moves.push({from:[rank,file],to:[r,f],special:special||null});
  }
  function ray(dr,df){
    let r=rank+dr,f=file+df;
    while(r>=0&&r<=7&&f>=0&&f<=7){
      const tgt=board[r][f];
      if(tgt){
        if(col(tgt)!==c) moves.push({from:[rank,file],to:[r,f],special:null});
        break;
      }
      moves.push({from:[rank,file],to:[r,f],special:null});
      r+=dr; f+=df;
    }
  }

  if(t==='P'){
    const dir=c==='w'?-1:1;
    const startRank=c==='w'?6:1;
    const promRank=c==='w'?0:7;
    const nr=rank+dir;
    if(nr>=0&&nr<=7&&!board[nr][file]){
      if(nr===promRank){
        for(const p of ['Q','R','B','N'])
          moves.push({from:[rank,file],to:[nr,file],special:'promo_'+p});
      } else {
        moves.push({from:[rank,file],to:[nr,file],special:null});
        if(rank===startRank&&!board[nr+dir][file])
          moves.push({from:[rank,file],to:[nr+dir,file],special:'doublepush'});
      }
    }
    for(const df of [-1,1]){
      const nf=file+df;
      if(nr>=0&&nr<=7&&nf>=0&&nf<=7){
        const tgt=board[nr][nf];
        if(tgt&&col(tgt)!==c){
          if(nr===promRank){
            for(const p of ['Q','R','B','N'])
              moves.push({from:[rank,file],to:[nr,nf],special:'promo_'+p});
          } else {
            moves.push({from:[rank,file],to:[nr,nf],special:null});
          }
        }
        if(enPassant&&nr===enPassant[0]&&nf===enPassant[1])
          moves.push({from:[rank,file],to:[nr,nf],special:'enpassant'});
      }
    }
  }
  if(t==='N'){
    for(const [dr,df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
      push(rank+dr,file+df);
  }
  if(t==='B'||t==='Q'){
    for(const [dr,df] of [[-1,-1],[-1,1],[1,-1],[1,1]]) ray(dr,df);
  }
  if(t==='R'||t==='Q'){
    for(const [dr,df] of [[-1,0],[1,0],[0,-1],[0,1]]) ray(dr,df);
  }
  if(t==='K'){
    for(const [dr,df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
      push(rank+dr,file+df);
  }
  return moves;
}

// ─── Apply a move to get a new board ────────────────────────────────────────
function applyMove(board, move, castling){
  const nb=cloneBoard(board);
  const nc={...castling};
  const [fr,ff]=move.from, [tr,tf]=move.to;
  const piece=nb[fr][ff];
  let newEP=null;

  if(move.special==='enpassant'){
    nb[fr][tf]=null; // remove captured pawn (same rank as moving pawn)
  }
  if(move.special==='doublepush'){
    const c=col(piece);
    newEP=[c==='w'?fr-1:fr+1, ff];
  }
  if(move.special==='castle_k'){
    const r=fr;
    nb[r][6]=piece; nb[r][4]=null;
    nb[r][5]=nb[r][7]; nb[r][7]=null;
    const c=col(piece);
    nc[c+'K']=false; nc[c+'Q']=false;
    return {board:nb,enPassant:newEP,castling:nc};
  }
  if(move.special==='castle_q'){
    const r=fr;
    nb[r][2]=piece; nb[r][4]=null;
    nb[r][3]=nb[r][0]; nb[r][0]=null;
    const c=col(piece);
    nc[c+'K']=false; nc[c+'Q']=false;
    return {board:nb,enPassant:newEP,castling:nc};
  }
  if(move.special&&move.special.startsWith('promo_')){
    nb[tr][tf]=col(piece)+move.special.slice(6);
    nb[fr][ff]=null;
  } else {
    nb[tr][tf]=piece;
    nb[fr][ff]=null;
  }
  // Update castling rights
  if(typ(piece)==='K'){ const c=col(piece); nc[c+'K']=false; nc[c+'Q']=false; }
  if(typ(piece)==='R'){
    const c=col(piece);
    if(ff===7) nc[c+'K']=false;
    if(ff===0) nc[c+'Q']=false;
  }
  // Rook captured
  if(tr===0&&tf===0) nc['bQ']=false;
  if(tr===0&&tf===7) nc['bK']=false;
  if(tr===7&&tf===0) nc['wQ']=false;
  if(tr===7&&tf===7) nc['wK']=false;
  return {board:nb,enPassant:newEP,castling:nc};
}

// ─── Check detection ─────────────────────────────────────────────────────────
function findKing(board,c){
  for(let r=0;r<8;r++) for(let f=0;f<8;f++)
    if(board[r][f]===c+'K') return [r,f];
  return null;
}
function isAttacked(board,rank,file,byColor){
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const p=board[r][f];
    if(!p||col(p)!==byColor) continue;
    if(pseudoMoves(board,r,f,null).some(m=>m.to[0]===rank&&m.to[1]===file)) return true;
  }
  return false;
}
function isInCheck(board,c){
  const k=findKing(board,c);
  return k?isAttacked(board,k[0],k[1],opp(c)):false;
}

// ─── Legal moves (filter out self-check, add castling) ──────────────────────
function getLegalMoves(board,c,enPassant,castling){
  const moves=[];
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const p=board[r][f];
    if(!p||col(p)!==c) continue;
    for(const m of pseudoMoves(board,r,f,enPassant)){
      const res=applyMove(board,m,castling);
      if(!isInCheck(res.board,c)) moves.push(m);
    }
  }
  // Castling
  const kr=c==='w'?7:0;
  const o=opp(c);
  if(castling[c+'K']&&board[kr][4]===c+'K'&&board[kr][7]===c+'R'
     &&!board[kr][5]&&!board[kr][6]
     &&!isInCheck(board,c)&&!isAttacked(board,kr,5,o)&&!isAttacked(board,kr,6,o)){
    moves.push({from:[kr,4],to:[kr,6],special:'castle_k'});
  }
  if(castling[c+'Q']&&board[kr][4]===c+'K'&&board[kr][0]===c+'R'
     &&!board[kr][1]&&!board[kr][2]&&!board[kr][3]
     &&!isInCheck(board,c)&&!isAttacked(board,kr,3,o)&&!isAttacked(board,kr,2,o)){
    moves.push({from:[kr,4],to:[kr,2],special:'castle_q'});
  }
  return moves;
}

// ─── Move notation ───────────────────────────────────────────────────────────
function toNotation(board,move,status){
  const [fr,ff]=move.from,[tr,tf]=move.to;
  const piece=board[fr][ff]; const t=typ(piece);
  if(move.special==='castle_k') return '0-0'+(status==='checkmate'?'#':status==='check'?'+':'');
  if(move.special==='castle_q') return '0-0-0'+(status==='checkmate'?'#':status==='check'?'+':'');
  let n='';
  if(t!=='P') n+=t;
  if(t==='P'&&(board[tr][tf]||move.special==='enpassant')) n+=rcToSquare(fr,ff)[0];
  if(board[tr][tf]||move.special==='enpassant') n+='x';
  n+=rcToSquare(tr,tf);
  if(move.special&&move.special.startsWith('promo_')) n+='='+move.special.slice(6);
  if(status==='checkmate') n+='#';
  else if(status==='check') n+='+';
  return n;
}

// ─── Insufficient material check ─────────────────────────────────────────────
function isInsufficientMaterial(board){
  const pieces=[];
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const p=board[r][f]; if(!p) continue;
    pieces.push({p,r,f});
  }
  if(pieces.length===2) return true; // K vs K
  if(pieces.length===3){
    const non=pieces.find(x=>typ(x.p)!=='K');
    if(non&&(typ(non.p)==='B'||typ(non.p)==='N')) return true; // K+B vs K or K+N vs K
  }
  if(pieces.length===4){
    const nonK=pieces.filter(x=>typ(x.p)!=='K');
    if(nonK.length===2&&nonK[0].p[1]==='B'&&nonK[1].p[1]==='B'&&col(nonK[0].p)!==col(nonK[1].p)){
      // K+B vs K+B — check same color squares
      const sc0=(nonK[0].r+nonK[0].f)%2;
      const sc1=(nonK[1].r+nonK[1].f)%2;
      if(sc0===sc1) return true;
    }
  }
  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────
function initGameState(){
  return {
    board:initBoard(),
    turn:'w',
    enPassant:null,
    castling:{wK:true,wQ:true,bK:true,bQ:true},
    status:'active',
    moves:[],
    halfmoveClock:0,
    fullmoveNumber:1,
  };
}

function makeMove(gameState, fromStr, toStr, promotionPiece){
  const from=squareToRC(fromStr);
  const to=squareToRC(toStr);
  const {board,turn,enPassant,castling}=gameState;
  const piece=board[from[0]][from[1]];
  if(!piece||col(piece)!==turn) return {error:'Not your piece'};

  const legal=getLegalMoves(board,turn,enPassant,castling);
  const promo=(promotionPiece||'Q').toUpperCase();
  let chosen=null;
  for(const m of legal){
    if(m.from[0]!==from[0]||m.from[1]!==from[1]) continue;
    if(m.to[0]!==to[0]||m.to[1]!==to[1]) continue;
    if(m.special&&m.special.startsWith('promo_')){
      if(m.special!=='promo_'+promo) continue;
    }
    chosen=m; break;
  }
  if(!chosen) return {error:'Illegal move'};

  const result=applyMove(board,chosen,castling);
  const newTurn=opp(turn);
  const newLegal=getLegalMoves(result.board,newTurn,result.enPassant,result.castling);

  let status='active';
  if(newLegal.length===0){
    status=isInCheck(result.board,newTurn)?'checkmate':'stalemate';
  } else if(isInCheck(result.board,newTurn)){
    status='check';
  } else if(isInsufficientMaterial(result.board)){
    status='insufficient';
  }

  // 50-move rule
  const newHalf=(typ(piece)==='P'||result.board[to[0]][to[1]]!==board[to[0]][to[1]])?0:(gameState.halfmoveClock||0)+1;
  if(newHalf>=100) status='fifty_move';

  const notation=toNotation(board,chosen,status);
  const moveStr=fromStr+toStr+(chosen.special&&chosen.special.startsWith('promo_')?chosen.special.slice(6).toLowerCase():'');

  return {
    board:result.board,
    turn:newTurn,
    enPassant:result.enPassant,
    castling:result.castling,
    status,
    notation,
    move:moveStr,
    halfmoveClock:newHalf,
    fullmoveNumber:(turn==='b')?(gameState.fullmoveNumber||1)+1:(gameState.fullmoveNumber||1),
  };
}

function getValidMovesForSquare(gameState, squareStr){
  const rc=squareToRC(squareStr);
  const {board,turn,enPassant,castling}=gameState;
  const piece=board[rc[0]][rc[1]];
  if(!piece||col(piece)!==turn) return [];
  const legal=getLegalMoves(board,turn,enPassant,castling);
  return legal
    .filter(m=>m.from[0]===rc[0]&&m.from[1]===rc[1])
    .map(m=>rcToSquare(m.to[0],m.to[1]));
}

module.exports={initGameState,makeMove,getLegalMoves,isInCheck,squareToRC,rcToSquare,getValidMovesForSquare,isInsufficientMaterial};
