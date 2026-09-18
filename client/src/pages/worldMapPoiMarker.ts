import type { WorldMapCategory } from '@/lib/worldMapLocations'

export type PoiMarkerState = 'default' | 'hovered' | 'selected'

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const resolvedRadius = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + resolvedRadius, y)
  ctx.lineTo(x + width - resolvedRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + resolvedRadius)
  ctx.lineTo(x + width, y + height - resolvedRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - resolvedRadius, y + height)
  ctx.lineTo(x + resolvedRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - resolvedRadius)
  ctx.lineTo(x, y + resolvedRadius)
  ctx.quadraticCurveTo(x, y, x + resolvedRadius, y)
  ctx.closePath()
}

export function drawPoiGlyph(
  ctx: CanvasRenderingContext2D,
  category: WorldMapCategory,
  x: number,
  y: number,
  size: number,
) {
  const half = size / 2
  const left = x - half
  const top = y - half
  ctx.save()
  ctx.strokeStyle = 'rgba(247, 249, 247, 0.98)'
  ctx.fillStyle = 'rgba(247, 249, 247, 0.98)'
  ctx.lineWidth = Math.max(1.4, size * 0.14)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()

  switch (category) {
    case 'town':
      ctx.moveTo(left + size * 0.1, y - size * 0.05)
      ctx.lineTo(x, top + size * 0.08)
      ctx.lineTo(left + size * 0.9, y - size * 0.05)
      ctx.moveTo(left + size * 0.22, y - size * 0.02)
      ctx.lineTo(left + size * 0.22, top + size * 0.88)
      ctx.lineTo(left + size * 0.78, top + size * 0.88)
      ctx.lineTo(left + size * 0.78, y - size * 0.02)
      ctx.stroke()
      break
    case 'medical':
      ctx.fillRect(x - size * 0.12, top + size * 0.08, size * 0.24, size * 0.84)
      ctx.fillRect(left + size * 0.08, y - size * 0.12, size * 0.84, size * 0.24)
      break
    case 'police':
      ctx.moveTo(x, top + size * 0.08)
      ctx.lineTo(left + size * 0.82, top + size * 0.22)
      ctx.lineTo(left + size * 0.76, top + size * 0.62)
      ctx.quadraticCurveTo(left + size * 0.7, top + size * 0.82, x, top + size * 0.94)
      ctx.quadraticCurveTo(left + size * 0.3, top + size * 0.82, left + size * 0.24, top + size * 0.62)
      ctx.lineTo(left + size * 0.18, top + size * 0.22)
      ctx.closePath()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(left + size * 0.34, top + size * 0.42)
      ctx.lineTo(left + size * 0.66, top + size * 0.42)
      ctx.stroke()
      break
    case 'fire':
      ctx.moveTo(x + size * 0.04, top + size * 0.08)
      ctx.bezierCurveTo(x + size * 0.34, top + size * 0.38, x + size * 0.38, top + size * 0.7, x, top + size * 0.94)
      ctx.bezierCurveTo(x - size * 0.4, top + size * 0.72, x - size * 0.28, top + size * 0.42, x - size * 0.08, top + size * 0.26)
      ctx.bezierCurveTo(x - size * 0.06, top + size * 0.48, x + size * 0.12, top + size * 0.5, x + size * 0.04, top + size * 0.08)
      ctx.closePath()
      ctx.fill()
      break
    case 'gun':
      ctx.arc(x, y, size * 0.28, 0, Math.PI * 2)
      ctx.moveTo(x - size * 0.48, y)
      ctx.lineTo(x - size * 0.2, y)
      ctx.moveTo(x + size * 0.2, y)
      ctx.lineTo(x + size * 0.48, y)
      ctx.moveTo(x, y - size * 0.48)
      ctx.lineTo(x, y - size * 0.2)
      ctx.moveTo(x, y + size * 0.2)
      ctx.lineTo(x, y + size * 0.48)
      ctx.stroke()
      break
    case 'shop':
      ctx.rect(left + size * 0.16, top + size * 0.3, size * 0.68, size * 0.58)
      ctx.moveTo(left + size * 0.32, top + size * 0.3)
      ctx.quadraticCurveTo(x, top, left + size * 0.68, top + size * 0.3)
      ctx.stroke()
      break
    case 'gas':
      ctx.rect(left + size * 0.1, top + size * 0.1, size * 0.54, size * 0.8)
      ctx.rect(left + size * 0.2, top + size * 0.22, size * 0.34, size * 0.24)
      ctx.moveTo(left + size * 0.64, top + size * 0.28)
      ctx.lineTo(left + size * 0.78, top + size * 0.38)
      ctx.quadraticCurveTo(left + size * 0.92, top + size * 0.48, left + size * 0.84, top + size * 0.74)
      ctx.lineTo(left + size * 0.76, top + size * 0.74)
      ctx.stroke()
      break
    case 'military':
      for (let index = 0; index < 5; index += 1) {
        const outerAngle = -Math.PI / 2 + index * Math.PI * 0.4
        const innerAngle = outerAngle + Math.PI * 0.2
        const outerRadius = size * 0.46
        const innerRadius = size * 0.2
        if (index === 0) ctx.moveTo(x + Math.cos(outerAngle) * outerRadius, y + Math.sin(outerAngle) * outerRadius)
        else ctx.lineTo(x + Math.cos(outerAngle) * outerRadius, y + Math.sin(outerAngle) * outerRadius)
        ctx.lineTo(x + Math.cos(innerAngle) * innerRadius, y + Math.sin(innerAngle) * innerRadius)
      }
      ctx.closePath()
      ctx.fill()
      break
    case 'landmark':
      ctx.moveTo(left + size * 0.18, top + size * 0.86)
      ctx.lineTo(left + size * 0.82, top + size * 0.86)
      ctx.moveTo(left + size * 0.28, top + size * 0.72)
      ctx.lineTo(left + size * 0.72, top + size * 0.72)
      ctx.moveTo(left + size * 0.36, top + size * 0.7)
      ctx.lineTo(left + size * 0.36, top + size * 0.36)
      ctx.lineTo(left + size * 0.64, top + size * 0.36)
      ctx.lineTo(left + size * 0.64, top + size * 0.7)
      ctx.moveTo(left + size * 0.28, top + size * 0.36)
      ctx.lineTo(x, top + size * 0.08)
      ctx.lineTo(left + size * 0.72, top + size * 0.36)
      ctx.stroke()
      break
    case 'industrial':
      ctx.moveTo(left + size * 0.18, top + size * 0.88)
      ctx.lineTo(left + size * 0.62, top + size * 0.44)
      ctx.moveTo(left + size * 0.48, top + size * 0.22)
      ctx.lineTo(left + size * 0.72, top + size * 0.08)
      ctx.lineTo(left + size * 0.92, top + size * 0.28)
      ctx.lineTo(left + size * 0.76, top + size * 0.5)
      ctx.closePath()
      ctx.stroke()
      break
  }
  ctx.restore()
}

export function drawPoiMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: WorldMapCategory,
  color: string,
  state: PoiMarkerState,
) {
  const selected = state === 'selected'
  const elevated = state !== 'default'
  const bodySize = selected ? 25 : elevated ? 23 : 21
  const pointerHeight = 6
  const bodyX = x - bodySize / 2
  const bodyY = y - bodySize - pointerHeight + 1

  ctx.save()
  if (elevated) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
    ctx.shadowBlur = selected ? 10 : 7
    ctx.shadowOffsetY = 2
  }

  ctx.beginPath()
  ctx.moveTo(x - 4.5, bodyY + bodySize - 1)
  ctx.lineTo(x, y)
  ctx.lineTo(x + 4.5, bodyY + bodySize - 1)
  ctx.closePath()
  ctx.fillStyle = 'rgba(9, 13, 16, 0.98)'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()

  roundRectPath(ctx, bodyX, bodyY, bodySize, bodySize, 5)
  ctx.fillStyle = 'rgba(9, 13, 16, 0.98)'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = selected ? 2.5 : 2
  ctx.stroke()
  ctx.shadowColor = 'transparent'

  if (selected) {
    roundRectPath(ctx, bodyX - 3.5, bodyY - 3.5, bodySize + 7, bodySize + 7, 7)
    ctx.strokeStyle = 'rgba(247, 249, 247, 0.96)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  } else if (state === 'hovered') {
    roundRectPath(ctx, bodyX - 2.5, bodyY - 2.5, bodySize + 5, bodySize + 5, 6.5)
    ctx.strokeStyle = 'rgba(247, 249, 247, 0.72)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  drawPoiGlyph(ctx, category, x, bodyY + bodySize / 2, bodySize * 0.52)
  ctx.restore()

  return { top: bodyY }
}