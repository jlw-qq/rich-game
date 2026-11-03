/**
 * 表现层：联网房间（开局前的大厅）。房间数据来自服务器，这里只负责显示和把房主的设置发出去。
 */
import { el } from './dom.js';
import { brandHeading } from './brandHeading.js';
import { PLAYER_COLORS } from '../render/theme.js';
import { MODES } from '../../data/config/modes.js';
import { canShare, shareOrCopy, SHARE_STATUS, pageUrl } from './clipboard.js';
import { encodeRoomLink } from '../../logic/systems/shareLink.js';

const SEAT_LABELS = { open: '空位 · 等人加入', closed: '关闭', normal: 'AI · 普通', easy: 'AI · 简单' };

/**
 * @param {{ root: HTMLElement, send: (msg: object) => void, onLeave: () => void }} options
 */
export function createLobby({ root, send, onLeave }) {
  let room = null;
  let message = '';
  let notice = '';

  function seatRow(seat, i) {
    const isHost = room.you === room.hostSeat;
    let body;
    if (seat.kind === 'human') {
      const tags = [i === room.hostSeat && '房主', i === room.you && '你'].filter(Boolean);
      body = el('span', { class: 'lobby-name' }, seat.name, tags.length > 0 && el('span', { class: 'muted' }, `（${tags.join('、')}）`));
    } else if (isHost && room.phase === 'lobby') {
      body = el(
        'select',
        { class: 'setup-kind', 'aria-label': `座位 ${i + 1}`, onchange: (e) => send({ t: 'setSeat', index: i, kind: e.target.value }) },
        Object.entries(SEAT_LABELS).map(([value, label]) => el('option', { value, selected: seat.kind === value }, label)),
      );
    } else {
      body = el('span', { class: seat.kind === 'closed' ? 'muted' : null }, SEAT_LABELS[seat.kind] ?? '已离开');
    }
    return el(
      'li',
      { class: `lobby-seat${seat.kind === 'closed' ? ' lobby-seat-closed' : ''}` },
      el('span', { class: 'player-dot player-seat', style: `background:${PLAYER_COLORS[i]}`, 'aria-hidden': 'true' }, i + 1),
      body,
    );
  }

  /** 复制或分享邀请链接；复制失败时显示链接让人手动复制 */
  function inviteRow(code) {
    const link = pageUrl(encodeRoomLink(code));
    const status = el('span', { class: 'muted', role: 'status' });
    const manual = el('input', { type: 'text', class: 'share-link', readonly: true, hidden: true, value: link, 'aria-label': '邀请链接', onfocus: (e) => e.target.select() });
    return el(
      'div',
      { class: 'lobby-invite' },
      el(
        'div',
        { class: 'actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              const r = await shareOrCopy({ title: '城市大富翁 · 联机邀请', text: `来城市大富翁一起玩，房间码 ${code}`, url: link });
              status.textContent = SHARE_STATUS[r];
              manual.hidden = r !== 'failed';
              if (r === 'failed') manual.focus();
            },
          },
          canShare() ? '分享邀请链接' : '复制邀请链接',
        ),
        status,
      ),
      manual,
    );
  }

  function render() {
    if (!room) return;
    const isHost = room.you === room.hostSeat;
    const editable = isHost && room.phase === 'lobby';
    root.replaceChildren(
      el(
        'div',
        { class: 'setup-form lobby' },
        brandHeading('h1', 28, { suffix: '联网房间' }),
        el('p', { class: 'lobby-code' }, '房间码 ', el('strong', {}, room.code)),
        room.phase === 'lobby' && inviteRow(room.code),
        el('p', { class: 'muted' }, '朋友打开邀请链接，或打开这个网页输入房间码，就能加入。'),
        el(
          'fieldset',
          { class: 'setup-modes' },
          el('legend', {}, '对局模式'),
          editable
            ? Object.entries(MODES).map(([key, m]) =>
                el(
                  'label',
                  { class: 'setup-mode' },
                  el('input', { type: 'radio', name: 'lobby-mode', value: key, checked: room.mode === key, onchange: () => send({ t: 'setMode', mode: key }) }),
                  el('span', { class: 'setup-mode-text' }, el('strong', {}, m.name), el('span', { class: 'muted' }, m.blurb)),
                ),
              )
            : el('span', { class: 'setup-mode-text' }, el('strong', {}, MODES[room.mode]?.name ?? room.mode), el('span', { class: 'muted' }, MODES[room.mode]?.blurb ?? '')),
        ),
        el('ol', { class: 'lobby-seats', 'aria-label': '座位' }, room.seats.map(seatRow)),
        el('ul', { class: 'setup-errors', role: 'alert' }, message && el('li', {}, message)),
        notice && el('p', { class: 'lobby-notice', role: 'status' }, notice),
        el(
          'div',
          { class: 'actions' },
          editable && el('button', { type: 'button', class: 'btn btn-primary', onclick: () => send({ t: 'start' }) }, '开始对局'),
          !isHost && room.phase === 'lobby' && el('span', { class: 'muted' }, '等房主开始……'),
          el('button', { type: 'button', class: 'btn', onclick: onLeave }, '离开房间'),
        ),
      ),
    );
    root.hidden = false;
  }

  return {
    /** @param {object} r 服务器发来的房间 */
    setRoom(r) {
      room = r;
      message = '';
      render();
    },
    /** 服务器拒绝了某个操作 */
    showError(text) {
      message = text;
      render();
    },
    /** 一般提示（不是错误） */
    showNotice(text) {
      notice = text;
      render();
    },
    hide() {
      room = null;
      message = '';
      notice = '';
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
