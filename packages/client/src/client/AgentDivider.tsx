/** Controlled companion divider; only an in-flight pointer gesture is local. */
import { useRef } from 'react'
import css from './Workbench.module.css'

/** Adjusts the shared Agent width with pointer capture or arrow keys.
 * @param props Current width, localized label and shared preference updater.
 * @returns Accessible vertical separator.
 */
export function AgentDivider({ width, onChange, label }: { width: number; onChange: (width: number) => void; label: string }) {
  const gesture = useRef<{ x: number; width: number; renderedWidth: number } | null>(null)
  return <div className={css.agentDivider} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={width}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      const panel = event.currentTarget.parentElement
      if (!panel) throw new Error('Agent divider must be mounted inside its panel')
      gesture.current = { x: event.clientX, width, renderedWidth: panel.getBoundingClientRect().width }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.focus()
      event.preventDefault()
    }}
    onPointerMove={(event) => {
      if (gesture.current) onChange(gesture.current.renderedWidth + gesture.current.x - event.clientX)
    }}
    onPointerUp={() => { gesture.current = null }}
    onLostPointerCapture={() => {
      if (gesture.current) onChange(gesture.current.width)
      gesture.current = null
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && gesture.current) {
        onChange(gesture.current.width); gesture.current = null; event.preventDefault()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        onChange(width + (event.key === 'ArrowLeft' ? 20 : -20)); event.preventDefault()
      }
    }} />
}
