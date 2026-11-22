// Interactions refer to local frame IDs. Only visible, top-level frames are playable.
export function prototypeFrames(store) {
  return store.doc.root.map((id) => store.get(id)).filter((n) => n?.type === 'frame' && n.visible && n.w > 0 && n.h > 0);
}

export function startFrame(store) {
  const frames = prototypeFrames(store);
  return frames.find((n) => n.id === store.doc.prototypeStart) ?? frames[0];
}

export function screenFor(store, node) {
  while (node?.parent) node = store.get(node.parent);
  return node?.type === 'frame' && node.visible && node.w > 0 && node.h > 0 ? node : null;
}

export function prototypeHotspots(store, frame) {
  const frames = new Set(prototypeFrames(store).map((n) => n.id));
  return [frame.id, ...store.descendants(frame.id)].filter((id) => {
    const action = store.get(id)?.prototypeAction;
    return store.isVisible(id) && (action?.type === 'back' ||
      (action?.type === 'navigate' && action.target !== frame.id && frames.has(action.target)));
  });
}

export function createPrototypeSession(store, initialFrame) {
  const start = prototypeFrames(store).find((n) => n.id === initialFrame) ?? startFrame(store);
  const history = [];
  let current = start?.id;
  return {
    get current() { return store.get(current); },
    get canGoBack() { return history.length > 0; },
    back() {
      const previous = history.pop();
      if (previous) current = previous;
      return !!previous;
    },
    restart() { history.length = 0; current = start?.id; },
    activate(id) {
      const frame = store.get(current);
      if (!frame || !prototypeHotspots(store, frame).includes(id)) return false;
      const action = store.get(id).prototypeAction;
      if (action.type === 'back') return this.back();
      history.push(current);
      current = action.target;
      return true;
    },
  };
}
