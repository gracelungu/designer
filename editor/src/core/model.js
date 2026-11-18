// Node types and defaults for the design document.
//
// Coordinates: every node stores its box (x, y, w, h) in its parent's coordinate
// space, which for unrotated parents is plain canvas (world) space. Rotation and
// flips are applied about the box centre. Children of a container live in that
// container's space, so moving a container moves its subtree by the same delta.

let counter = 0;
export function uid() {
  counter = (counter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 7) + counter.toString(36);
}

export const CONTAINERS = new Set(['frame', 'section', 'group']);
export const isContainer = (n) => !!n && CONTAINERS.has(n.type);
export const isFrameLike = (n) => !!n && (n.type === 'frame' || n.type === 'section');
export const isLine = (n) => !!n && (n.type === 'line' || n.type === 'arrow');

export const TYPE_LABEL = {
  frame: 'Frame', section: 'Section', group: 'Group', rect: 'Rectangle', ellipse: 'Ellipse',
  line: 'Line', arrow: 'Arrow', polygon: 'Polygon', star: 'Star', vector: 'Vector',
  text: 'Text', image: 'Image',
};

export const solid = (color, opacity = 1) => ({ type: 'solid', color, opacity, visible: true });
export const stroke = (color = '#000000', opacity = 1) => ({ type: 'solid', color, opacity, visible: true });

export function shadow(kind = 'drop-shadow') {
  if (kind === 'layer-blur') return { type: kind, blur: 4, visible: true };
  return { type: kind, x: 0, y: 4, blur: 4, spread: 0, color: '#000000', opacity: 0.25, visible: true };
}

export const DEFAULT_TEXT = {
  content: '',
  fontFamily: 'Inter',
  fontSize: 16,
  fontWeight: 400,
  italic: false,
  underline: false,
  strike: false,
  lineHeight: null, // null = auto (1.2)
  letterSpacing: 0, // percent of font size, like Figma
  align: 'left',
  valign: 'top',
  autoResize: 'width', // 'width' | 'height' | 'fixed'
  textCase: 'none',
};

export function createNode(type, props = {}) {
  const n = {
    id: uid(),
    type,
    name: TYPE_LABEL[type] || type,
    parent: null,
    x: 0, y: 0, w: 100, h: 100,
    rotation: 0, flipX: false, flipY: false,
    visible: true, locked: false, opacity: 1,
    fills: [], strokes: [], strokeWidth: 1, strokeAlign: 'inside',
    effects: [],
    radius: 0, radii: null,
    constraints: { h: 'left', v: 'top' },
    sizing: { h: 'fixed', v: 'fixed' },
    absolute: false,
  };
  switch (type) {
    case 'frame':
      Object.assign(n, { fills: [solid('#FFFFFF')], children: [], clip: true, layout: null });
      break;
    case 'section':
      Object.assign(n, { fills: [solid('#F4F4F5')], strokes: [stroke('#D4D4D8')], children: [], clip: false, radius: 6, layout: null });
      break;
    case 'group':
      Object.assign(n, { children: [] });
      break;
    case 'rect':
    case 'ellipse':
      n.fills = [solid('#D9D9D9')];
      break;
    case 'polygon':
      Object.assign(n, { fills: [solid('#D9D9D9')], pointCount: 3 });
      break;
    case 'star':
      Object.assign(n, { fills: [solid('#D9D9D9')], pointCount: 5, innerRatio: 0.382 });
      break;
    case 'line':
    case 'arrow':
      Object.assign(n, { h: 0, strokes: [stroke('#000000')], strokeAlign: 'center', strokeCap: type === 'arrow' ? 'arrow' : 'none' });
      break;
    case 'vector':
      Object.assign(n, { strokes: [stroke('#000000')], strokeAlign: 'center', points: [], closed: false });
      break;
    case 'text':
      Object.assign(n, { fills: [solid('#000000')], text: { ...DEFAULT_TEXT } });
      break;
    case 'image':
      Object.assign(n, { fills: [{ type: 'image', asset: null, fit: 'fill', opacity: 1, visible: true }] });
      break;
  }
  return Object.assign(n, props);
}

/** Generic device presets for the frame tool. */
export const FRAME_PRESETS = [
  { group: 'Phone', items: [
    { name: 'Phone', w: 393, h: 852 },
    { name: 'Phone Pro Max', w: 440, h: 956 },
    { name: 'Phone SE', w: 375, h: 667 },
    { name: 'Android Compact', w: 412, h: 917 },
    { name: 'Android Medium', w: 700, h: 840 },
  ] },
  { group: 'Tablet', items: [
    { name: 'Tablet mini', w: 744, h: 1133 },
    { name: 'Tablet Pro 11"', w: 834, h: 1194 },
    { name: 'Tablet Pro 13"', w: 1032, h: 1376 },
    { name: 'Android Expanded', w: 1280, h: 800 },
  ] },
  { group: 'Desktop', items: [
    { name: 'Laptop 13"', w: 1280, h: 832 },
    { name: 'Laptop 16"', w: 1728, h: 1117 },
    { name: 'Desktop', w: 1440, h: 1024 },
    { name: 'Wide desktop', w: 1920, h: 1080 },
  ] },
  { group: 'Presentation & social', items: [
    { name: 'Slide 16:9', w: 1920, h: 1080 },
    { name: 'Slide 4:3', w: 1024, h: 768 },
    { name: 'Square post', w: 1080, h: 1080 },
    { name: 'Story', w: 1080, h: 1920 },
  ] },
  { group: 'Paper', items: [
    { name: 'A4', w: 595, h: 842 },
    { name: 'Letter', w: 612, h: 792 },
  ] },
];

export const FONTS = ['Inter', 'Roboto', 'Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'JetBrains Mono', 'Courier New'];
export const WEIGHTS = [
  [100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
  [600, 'Semi Bold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black'],
];
