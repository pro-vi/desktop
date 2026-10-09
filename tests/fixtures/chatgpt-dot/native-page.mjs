import vm from 'node:vm';

export const binding = Object.freeze({ dotUrl: 'https://chatgpt.com/dots/fixture-conversation', conversationId: 'fixture-conversation', roomId: 'fixture-room', peerAeonId: 'fixture-peer', accountKey: 'fixture-account' });

export function createNativeDotPage({ settle = true, initial = [] } = {}) {
  const state = { messages: [...initial], inputCount: 0, chatInputCount: 0, texts: [], draft: '', attachments: [], loaded: true, after: null, before: null, unconfirmed: [], roomId: binding.roomId, peer: binding.peerAeonId, account: binding.accountKey, beforeSubmit: null, history: null };
  const editor = { get textContent() { return state.draft; }, getBoundingClientRect: () => ({ width: 20, height: 20 }), closest: () => null };
  const services = {
    conversations: { timeline: () => ({ getSnapshot: () => ({ messages: state.messages, loaded: state.loaded, cursors: { after: state.after, before: state.before } }) }) },
    composer: {
      state: { getSnapshot: () => ({ drafts: new Map([[state.roomId, { text: state.draft }]]), unconfirmedSends: state.unconfirmed.map((requestId) => ({ request: { requestId, roomId: state.roomId } })) }) },
      getAttachmentDraft: () => state.attachments,
      sendPrepared: (roomId, request) => {
        state.inputCount++;
        state.texts.push(request.text);
        state.messages.push({ id: settle ? `accepted-${state.inputCount}` : request.requestId, roomId, senderId: 'fixture-owner', senderAeonId: null, self: true, role: 'user', requestId: request.requestId, deliveryState: settle ? '' : 'pending', text: request.text, createdAt: request.createdAt, attachments: [] });
        if (!settle) state.unconfirmed.push(request.requestId);
        return true;
      }
    }
  };
  const visible = { getBoundingClientRect: () => ({ width: 100, height: 100 }), closest: () => null };
  const sidebar = { ...visible, click: () => { location.href = binding.dotUrl; location.pathname = '/dots/fixture-conversation'; }, getAttribute: () => 'page' };
  const scroller = { scrollHeight: 200, clientHeight: 100, scrollTo: () => state.history?.() };
  const main = { ...visible, querySelectorAll: (selector) => selector === '*' ? [scroller] : [editor] };
  const location = { origin: 'https://chatgpt.com', pathname: '/dots/fixture-conversation', href: binding.dotUrl };
  const context = vm.createContext({ Map, Set, Date, location, getComputedStyle: (node) => ({ display: 'block', visibility: 'visible', overflowY: node === scroller ? 'auto' : 'visible' }), document: { querySelectorAll: (selector) => selector === 'main' ? state.mainNodes || [main] : [sidebar] } });
  const updateProps = () => {
    const props = { conversationId: binding.conversationId, roomId: state.roomId, room: { id: state.roomId, aeon_id: state.peer, members: [{ id: 'fixture-peer-member', aeon_id: state.peer }, { id: 'fixture-owner', aeon_id: null }] }, services };
    main.__reactProps$fixture = props;
    main.__reactFiber$fixture = { memoizedProps: props, return: null };
    const account = { accountKey: state.account };
    sidebar.__reactProps$fixture = account;
    sidebar.__reactFiber$fixture = { memoizedProps: account, return: null };
  };
  const page = {
    getUrl: async () => location.href,
    navigate: async (url) => { const destination = state.navigateRedirect || url; location.href = destination; location.pathname = new URL(destination).pathname; },
    evaluate: async (script) => {
      if (script.includes('"action":"submit"')) state.beforeSubmit?.();
      updateProps();
      return structuredClone(vm.runInContext(script, context));
    }
  };
  const incoming = (id, text = id, extra = {}) => ({ id, text, roomId: state.roomId, senderId: 'fixture-peer-member', senderAeonId: state.peer, self: false, role: 'user', requestId: '', deliveryState: '', createdAt: '2026-10-08T00:00:00Z', attachments: [], ...extra });
  return { state, page, incoming, services, location, main };
}
