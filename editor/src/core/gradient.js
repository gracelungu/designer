const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

export function gradientStops(paint) {
  return (Array.isArray(paint.stops) ? paint.stops : [])
    .filter((stop) => stop && typeof stop.color === 'string' && HEX.test(stop.color) && Number.isFinite(stop.position))
    .map(({ color, position, opacity }) => ({
      color,
      position: Math.max(0, Math.min(1, position)),
      opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1,
    }))
    .sort((a, b) => a.position - b.position);
}

export function createGradient(type, previous) {
  return {
    type,
    angle: previous.angle ?? 90,
    opacity: previous.opacity ?? 1,
    visible: previous.visible,
    stops: previous.stops ?? [
      { color: previous.color ?? '#D9D9D9', position: 0, opacity: 1 },
      { color: '#222222', position: 1, opacity: 1 },
    ],
  };
}
