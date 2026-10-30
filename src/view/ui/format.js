/**
 * 表现层：把逻辑层事件翻译成日志文字。纯函数，不碰 DOM。
 */

/** @param {number} n */
export const money = (n) => `${n.toLocaleString('zh-CN')} 元`;

const DECK_NAMES = { chance: '机会', fate: '命运' };

/**
 * 城市事件选项的说明：写明结果和概率，帮助玩家判断。稳妥选项的按钮文字已经写明金额，返回空字符串。
 * @param {{ outcome: object, available: boolean, chance: number | null, target: { name: string } | null }} o
 */
export function choiceDetail(o) {
  const out = o.outcome;
  if (out.type === 'gain') return '';
  if (out.type === 'upgrade') return o.target ? `${o.target.name} 免费升一级` : '没有可以升级的地产（需要拥有整个颜色组）';
  const pct = Math.round(o.chance * 100);
  return `掷两颗骰子：${out.target} 点及以上（${pct}%）得 ${money(out.win)}，否则付 ${money(out.lose)}`;
}

/**
 * 交易一边的内容，如“西宁、银川、500 元、出狱卡 ×1”
 * @param {{ properties: string[], cash: number, jailCards: number }} side
 * @param {{ tiles: readonly object[] }} board
 */
export function tradeSideText(side, board) {
  const parts = [
    ...side.properties.map((id) => board.tiles.find((t) => t.id === id)?.name ?? id),
    side.cash > 0 && money(side.cash),
    side.jailCards > 0 && `出狱卡 ×${side.jailCards}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('、') : '什么都不给';
}

const RELEASE_TEXT = {
  bail: '交保释金出狱',
  card: '使用出狱卡出狱',
  doubles: '掷出双数，出狱',
  forcedBail: '坐满回合，交保释金出狱',
};

/**
 * @param {string} type
 * @param {any} p 事件 payload
 * @param {{ state: object, board: { tiles: readonly object[] }, cards: object[] }} ctx
 * @returns {string | null} null 表示该事件不写日志
 */
export function formatEvent(type, p, { state, board, cards }) {
  const name = (id) => state.players.find((x) => x.id === id)?.name ?? '银行';
  const tileName = (id) => board.tiles.find((t) => t.id === id)?.name ?? id;
  const cardTitle = (id) => cards.find((c) => c.id === id)?.title ?? '卡牌';

  function reasonText(reason) {
    switch (reason?.type) {
      case 'rent':
        return `${tileName(reason.tileId)}的租金`;
      case 'tax':
        return tileName(reason.tileId);
      case 'card':
        return `「${cardTitle(reason.cardId)}」`;
      case 'bail':
      case 'forcedBail':
        return '保释金';
      default:
        return '';
    }
  }

  switch (type) {
    case 'turnStarted':
      return `—— 第 ${p.round} 轮 · ${name(p.playerId)} 的回合 ——`;
    case 'extraRollGranted':
      return `${name(p.playerId)} 掷出双数，再掷一次`;
    case 'diceRolled': {
      const tail = p.isDouble ? '（双数）' : '';
      return `${name(p.playerId)} 掷出 ${p.dice.join(' + ')} = ${p.total}${tail}`;
    }
    case 'playerMoved':
      return `${name(p.playerId)} 来到 ${board.tiles[p.to]?.name ?? p.to}`;
    case 'passedStart':
      return `${name(p.playerId)} 经过起点，获得 ${money(p.amount)}`;
    case 'purchaseOffered':
      return `${tileName(p.tileId)} 无人拥有，售价 ${money(p.price)}`;
    case 'propertyBought':
      return `${name(p.playerId)} 买下 ${tileName(p.tileId)}，花费 ${money(p.price)}`;
    case 'purchaseDeclined':
      return `${name(p.playerId)} 没有买 ${tileName(p.tileId)}`;
    case 'paymentMade': {
      const to = p.payeeIds.length > 0 ? p.payeeIds.map(name).join('、') : '银行';
      const why = reasonText(p.reason);
      return `${name(p.payerId)} 付给 ${to} ${money(p.amount)}${why ? `（${why}）` : ''}`;
    }
    case 'cashGained':
      return `${name(p.playerId)} 获得 ${money(p.amount)}`;
    case 'debtPending':
      return `${name(p.debtorId)} 需要支付 ${money(p.amount)}，但现金只有 ${money(p.cash)}`;
    case 'cardDrawn': {
      const card = cards.find((c) => c.id === p.cardId);
      return `${name(p.playerId)} 抽到${DECK_NAMES[p.deck] ?? ''}卡「${card?.title ?? p.cardId}」：${card?.text ?? ''}`;
    }
    case 'cardChainLimited':
      return '卡牌连续移动次数达到上限，停在原地';
    case 'sentToJail':
      return `${name(p.playerId)} 被送进监狱`;
    case 'releasedFromJail':
      return `${name(p.playerId)} ${RELEASE_TEXT[p.method] ?? '出狱'}`;
    case 'propertyUpgraded':
      if (p.free) return `${name(p.playerId)} 的 ${tileName(p.tileId)} 免费升到 ${p.level} 级`;
      return `${name(p.playerId)} 把 ${tileName(p.tileId)} 升到 ${p.level} 级，花费 ${money(p.cost)}`;
    case 'buildingSold':
      return `${name(p.playerId)} 卖掉 ${tileName(p.tileId)} 的一级建筑，得到 ${money(p.refund)}`;
    case 'propertyMortgaged':
      return `${name(p.playerId)} 抵押 ${tileName(p.tileId)}，得到 ${money(p.amount)}`;
    case 'propertyRedeemed':
      return `${name(p.playerId)} 赎回 ${tileName(p.tileId)}，花费 ${money(p.cost)}`;
    case 'tradeProposed': {
      const t = p.trade;
      return `${name(t.fromId)} 向 ${name(t.toId)} 提议交易：拿出 ${tradeSideText(t.give, board)}，换取 ${tradeSideText(t.take, board)}`;
    }
    case 'tradeAccepted':
      return `${name(p.trade.toId)} 接受了交易`;
    case 'tradeRejected':
      return `${name(p.trade.toId)} 拒绝了交易`;
    case 'choiceOffered': {
      const card = cards.find((c) => c.id === p.cardId);
      return `${name(p.playerId)} 遇到城市事件「${card?.title ?? p.cardId}」，要做个选择`;
    }
    case 'choiceMade': {
      const card = cards.find((c) => c.id === p.cardId);
      return `${name(p.playerId)} 选择了「${card?.effect.options[p.index]?.label ?? p.index}」`;
    }
    case 'gambleRolled':
      // 金额由紧随其后的收款、付款日志写明，这里只写掷骰结果
      return `${name(p.playerId)} 掷出 ${p.dice.join(' + ')} = ${p.total}，${p.won ? '冒险成功！' : `没到 ${p.target} 点，冒险失败`}`;
    case 'playerBankrupt':
      return `${name(p.playerId)} 破产了`;
    case 'assetsLiquidated':
      if (p.properties.length === 0) return null;
      return p.heirId
        ? `${name(p.debtorId)} 的地产全部转给 ${name(p.heirId)}`
        : `${name(p.debtorId)} 的地产收归银行`;
    case 'gameOver':
      if (!p.winnerId) return '游戏结束，没有赢家';
      if (p.reason === 'roundLimit') return `打满 ${state.round} 轮，${name(p.winnerId)} 以总资产最高获胜！`;
      if (p.reason === 'goal') return `${name(p.winnerId)} 总资产率先达到目标，获胜！`;
      return `${name(p.winnerId)} 获胜！其他玩家全部破产`;
    default:
      return null;
  }
}

/** 挑战成绩一行字：第 2/4 名 · 总资产 23,400 元 · 25 轮 */
export function scoreText(score) {
  const worth = score.bankrupt ? '已破产' : `总资产 ${money(score.netWorth)}`;
  return `第 ${score.rank}/${score.players} 名 · ${worth} · ${score.round} 轮`;
}

/** 每日挑战日期 2026-10-30 → 10 月 30 日 */
export function dateLabel(dateKey) {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m} 月 ${d} 日`;
}

/** 发给别人比较的成绩文字（本地生成，别人无法核实，只是方便分享） */
export function shareText({ code, daily, score }) {
  const title = daily ? `城市大富翁 · ${dateLabel(daily)}每日挑战` : '城市大富翁 · 挑战';
  return `${title}\n挑战码 ${code}\n我的成绩：${scoreText(score)}`;
}
