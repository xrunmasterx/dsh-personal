/** Task Markdown with authenticated, durable screenshot resolution. */
import { useEffect, useState } from 'react'
import css from './TaskDocument.module.css'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render a description without persisting display URLs.
 * @param props Markdown, native image reader and localized rendering labels.
 * @returns Markdown plus visible image-loading failures.
 */
export function TaskDocument({ text, readImage, labels, failedLabel, retryLabel }: {
  text: string
  readImage: (destination: string) => Promise<string>
  labels: MarkdownLabels
  failedLabel: string
  retryLabel: string
}) {
  const [images, setImages] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const destinations = JSON.stringify([...new Set(text.match(/personal-image:v(?:1:[A-Za-z0-9_-]+|2:[a-f0-9]{64}\.(?:png|jpeg|webp|gif))/g) ?? [])])
  useEffect(() => {
    let active = true
    setFailed(false)
    setImages({})
    for (const destination of JSON.parse(destinations) as string[]) {
      void readImage(destination).then((url) => {
        if (active) setImages(current => ({ ...current, [destination]: url }))
      }).catch(() => { if (active) setFailed(true) })
    }
    return () => { active = false }
  }, [destinations, readImage, attempt])
  return <div className={css.document}>
    <MarkdownText text={text} labels={labels} pathImages={{ resolve: destination => images[destination] }} />
    {failed && <p role="alert">{failedLabel} <button onClick={() => { setAttempt(value => value + 1) }}>{retryLabel}</button></p>}
  </div>
}
