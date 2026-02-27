import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { spawn, spawnSync } from 'child_process'
import crypto from 'crypto'

const clipperDir = path.resolve(__dirname, '../backend')
const clipsDir = path.join(clipperDir, 'clips')

/** Read the internal Family name (nameID=1) from a TTF/OTF file. */
function getFontFamilyName(fontPath: string): string {
  try {
    const data = fs.readFileSync(fontPath)
    const sig = data.slice(0, 4).toString('hex')
    // Skip TTC collections — not supported here
    if (sig === '74746366') return ''
    const numTables = data.readUInt16BE(4)
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16
      const tag = data.slice(base, base + 4).toString('ascii')
      if (tag === 'name') {
        const tblOffset = data.readUInt32BE(base + 8)
        const count = data.readUInt16BE(tblOffset + 2)
        const strBase = tblOffset + data.readUInt16BE(tblOffset + 4)
        for (let j = 0; j < count; j++) {
          const r = tblOffset + 6 + j * 12
          const platformId = data.readUInt16BE(r)
          const nameId     = data.readUInt16BE(r + 6)
          const length     = data.readUInt16BE(r + 8)
          const strOff     = data.readUInt16BE(r + 10)
          if (nameId === 1) {
            const raw = data.slice(strBase + strOff, strBase + strOff + length)
            if (platformId === 3) {
              // UTF-16 BE — swap bytes for Node's utf16le
              const swapped = Buffer.alloc(raw.length)
              for (let k = 0; k < raw.length; k += 2) {
                swapped[k]     = raw[k + 1]
                swapped[k + 1] = raw[k]
              }
              return swapped.toString('utf16le').trim()
            }
            return raw.toString('latin1').trim()
          }
        }
      }
    }
  } catch { /* ignore */ }
  return ''
}

interface ActiveJob {
  id: string
  process: ReturnType<typeof spawn>
  videoId: string
  url: string
  startedAt: string
}
const activeJobs = new Map<string, ActiveJob>()

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'clipper-api',
      configureServer(server) {
        // GET /api/jobs - Returns array of all active/recent job states
        server.middlewares.use('/api/jobs', (_req, res) => {
          if (_req.url !== '/' && _req.url !== '') { return }
          const jobs: any[] = []
          try {
            const files = fs.readdirSync(clipperDir).filter(f => f.match(/^pipeline_state_[a-f0-9]+\.json$/))
            for (const f of files) {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(clipperDir, f), 'utf-8'))
                const jobId = f.replace('pipeline_state_', '').replace('.json', '')
                data.jobId = jobId
                data.isActive = activeJobs.has(jobId)
                jobs.push(data)
              } catch {}
            }
          } catch {}
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(jobs))
        })

        // GET /api/state - backward compat, returns most recent job state
        server.middlewares.use('/api/state', (_req, res) => {
          // Try per-job state files first (most recently modified)
          try {
            const files = fs.readdirSync(clipperDir)
              .filter(f => f.match(/^pipeline_state_[a-f0-9]+\.json$/))
              .map(f => ({ name: f, mtime: fs.statSync(path.join(clipperDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)
            if (files.length > 0) {
              res.setHeader('Content-Type', 'application/json')
              res.end(fs.readFileSync(path.join(clipperDir, files[0].name), 'utf-8'))
              return
            }
          } catch {}
          // Fall back to legacy single state file
          const file = path.join(clipperDir, 'pipeline_state.json')
          try {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.readFileSync(file, 'utf-8'))
          } catch {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ status: 'idle', logs: [], clips: [], steps: {} }))
          }
        })

        // POST /api/history/clear - clear history by status (MUST be before /api/history)
        server.middlewares.use('/api/history/clear', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return }
          let body = ''
          req.on('data', (c: Buffer) => body += c)
          req.on('end', () => {
            try {
              const { status } = JSON.parse(body) // 'error', 'done', or 'all'
              const file = path.join(clipperDir, 'pipeline_history.json')
              let history: any[] = []
              try { history = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch {}
              if (status === 'all') {
                history = []
              } else {
                history = history.filter((h: any) => h.status !== status)
              }
              fs.writeFileSync(file, JSON.stringify(history, null, 2))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, remaining: history.length }))
            } catch (e: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
          return
        })

        // GET /api/history
        server.middlewares.use('/api/history', (_req, res) => {
          const file = path.join(clipperDir, 'pipeline_history.json')
          try {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.readFileSync(file, 'utf-8'))
          } catch {
            res.setHeader('Content-Type', 'application/json')
            res.end('[]')
          }
        })

                // GET /api/fonts/file/:filename — serve individual font files for browser preview
        server.middlewares.use('/api/fonts/file', (req, res, next) => {
          const filename = (req.url || '').replace(/^\//, '').split('?')[0]
          if (!filename) { next(); return }
          const fontPath = path.join(clipperDir, 'fonts', filename)
          if (!fs.existsSync(fontPath)) { res.statusCode = 404; res.end('Not found'); return }
          const ext = path.extname(filename).toLowerCase()
          const mime = ext === '.ttf' ? 'font/ttf' : ext === '.otf' ? 'font/otf' : ext === '.woff2' ? 'font/woff2' : 'font/ttf'
          res.setHeader('Content-Type', mime)
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=86400')
          fs.createReadStream(fontPath).pipe(res)
        })

        // GET /api/fonts - list available fonts
        server.middlewares.use('/api/fonts', (req, res) => {
          if (req.url !== '/' && req.url !== '' && req.url !== '/download') { return }

          // POST /api/fonts/download
          if (req.url === '/download' && req.method === 'POST') {
            let body = ''
            req.on('data', (c: Buffer) => body += c)
            req.on('end', async () => {
              try {
                const { family } = JSON.parse(body)
                if (!family) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'family required' })); return }

                const fontsDir = path.join(clipperDir, 'fonts')
                if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true })

                // Use old Android UA — forces Google Fonts to serve TTF instead of WOFF2
                // WOFF2 cannot be used by ffmpeg/libass; TTF is required
                const TTF_UA = 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1'
                const cssUrl = `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}`
                const css = await new Promise<string>((resolve, reject) => {
                  https.get(cssUrl, { headers: { 'User-Agent': TTF_UA } }, r => {
                    if (r.statusCode !== 200) { reject(new Error(`Google Fonts returned ${r.statusCode}`)); return }
                    let data = ''; r.on('data', (c: any) => data += c); r.on('end', () => resolve(data))
                  }).on('error', reject)
                })

                // Extract TTF URL specifically
                const urlMatch = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/)
                if (!urlMatch) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'No TTF found for this font — try another' })); return }
                const fontUrl = urlMatch[1]
                const ext = '.ttf'

                // Download font binary
                const fontBuf = await new Promise<Buffer>((resolve, reject) => {
                  https.get(fontUrl, r => {
                    const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)))
                  }).on('error', reject)
                })

                const safeName = family.replace(/\s+/g, '') + '-Regular' + ext
                const displayName = family
                fs.writeFileSync(path.join(fontsDir, safeName), fontBuf)

                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, filename: safeName, displayName }))
              } catch (e: any) {
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, error: e.message }))
              }
            })
            return
          }

          // GET /api/fonts
          const fontsDir = path.join(clipperDir, 'fonts')
          try {
            const files = fs.readdirSync(fontsDir).filter(f => /\.(ttf|otf|woff2?)$/i.test(f))
            const fonts = files.map(f => {
              const fontPath = path.join(fontsDir, f)
              const internalName = getFontFamilyName(fontPath)
              const fallbackName = f.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim()
              return {
                filename: f,
                displayName: internalName || fallbackName,
              }
            })
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(fonts))
          } catch {
            res.setHeader('Content-Type', 'application/json')
            res.end('[]')
          }
          return
        })

        // GET/POST /api/settings
        server.middlewares.use('/api/settings', (req, res) => {
          const file = path.join(clipperDir, 'settings.json')
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (c: Buffer) => body += c)
            req.on('end', () => {
              try {
                let existing: Record<string, unknown> = {}
                try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch {}
                const newSettings = { ...existing, ...JSON.parse(body) }
                fs.writeFileSync(file, JSON.stringify(newSettings, null, 2))
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true }))
              } catch (e: any) {
                res.statusCode = 500
                res.end(JSON.stringify({ error: e.message }))
              }
            })
          } else {
            try {
              res.setHeader('Content-Type', 'application/json')
              res.end(fs.readFileSync(file, 'utf-8'))
            } catch {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({
                model: 'google/gemini-2.0-flash-001',
                max_clips: 5,
                min_duration: 45,
                max_duration: 90,
                openrouter_api_key: '',
                groq_api_key: '',
                gemini_api_key: '',
                transcription_provider: 'groq'
              }))
            }
          }
          return
        })

        // GET /api/models - fetch available models from OpenRouter
        server.middlewares.use('/api/models', async (req, res) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
          try {
            let orKey = ''
            try {
              const s = JSON.parse(fs.readFileSync(path.join(clipperDir, 'settings.json'), 'utf-8'))
              orKey = s.openrouter_api_key || ''
            } catch {}
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (orKey) headers['Authorization'] = `Bearer ${orKey}`
            const r = await (globalThis.fetch || require('node-fetch'))('https://openrouter.ai/api/v1/models', { headers })
            if (!r.ok) throw new Error(`OR ${r.status}`)
            const data = await r.json() as any
            const models = (data.data || [])
              .map((m: any) => ({ id: m.id, name: m.name || m.id }))
              .sort((a: any, b: any) => a.id.localeCompare(b.id))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(models))
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: e.message }))
          }
        })

        // GET /api/cache-status?videoId=
        server.middlewares.use('/api/cache-status', (req, res) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
          const videoId = new URL(req.url!, 'http://localhost').searchParams.get('videoId')
          if (!videoId) { res.statusCode = 400; res.end(JSON.stringify({ error: 'videoId required' })); return }
          res.setHeader('Content-Type', 'application/json')
          try {
            const cacheFile = path.join(clipperDir, 'video_cache', `${videoId}.json`)
            if (fs.existsSync(cacheFile)) {
              const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
              res.end(JSON.stringify({ cached: true, model: cache.model_used || null, moments: (cache.moments || []).length }))
            } else {
              res.end(JSON.stringify({ cached: false, model: null, moments: 0 }))
            }
          } catch {
            res.end(JSON.stringify({ cached: false, model: null, moments: 0 }))
          }
        })

        // GET /api/video-info?url=
        server.middlewares.use('/api/video-info', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost').searchParams.get('url')
          if (!url) { res.statusCode = 400; res.end(JSON.stringify({ error: 'url required' })); return }

          // Extract video ID
          const vidMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)
          const videoId = vidMatch?.[1]

          // Try YouTube oEmbed first (no auth, always works)
          try {
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
            const oRes = await fetch(oembedUrl)
            if (oRes.ok) {
              const oembed = await oRes.json() as any
              // Use maxresdefault thumbnail, fallback to hqdefault
              const thumbnail = videoId
                ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
                : oembed.thumbnail_url
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({
                title: oembed.title,
                thumbnail,
                channel: oembed.author_name,
                channel_url: oembed.author_url,
                duration: 0,
                view_count: 0,
                upload_date: '',
                video_id: videoId || '',
              }))
              return
            }
          } catch {}

          // Fallback: yt-dlp with cookies
          try {
            const ytdlp = spawnSync('yt-dlp', [
              '--cookies-from-browser', 'chrome', '--remote-components', 'ejs:github',
              '--dump-json', '--no-download', '--no-warnings', url
            ], { timeout: 15000, encoding: 'utf-8' })
            if (ytdlp.status !== 0) throw new Error(ytdlp.stderr || 'yt-dlp failed')
            const info = JSON.parse(ytdlp.stdout)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              title: info.title,
              thumbnail: info.thumbnail,
              channel: info.channel || info.uploader,
              channel_url: info.channel_url || info.uploader_url,
              duration: info.duration,
              view_count: info.view_count,
              upload_date: info.upload_date,
              video_id: info.id,
            }))
          } catch (e: any) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        })

        // POST /api/run - start clipper pipeline (multi-job)
        server.middlewares.use('/api/run', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return }
          let body = ''
          req.on('data', (c: Buffer) => body += c)
          req.on('end', async () => {
            try {
              const { url, max_clips, min_duration, max_duration, reanalyze, model_override } = JSON.parse(body)
              if (!url) { res.statusCode = 400; res.end(JSON.stringify({ error: 'url required' })); return }

              const jobId = crypto.randomBytes(4).toString('hex')

              // Load env vars from zshrc for API keys
              const envVars = { ...process.env }
              try {
                const zshrc = fs.readFileSync(path.join(process.env.HOME!, '.zshrc'), 'utf-8')
                for (const match of zshrc.matchAll(/export\s+(\w+)="([^"]*)"/g)) {
                  envVars[match[1]] = match[2]
                }
              } catch {}

              const vidMatch = url.match(/[?&]v=([^&]+)/)
              const videoId = vidMatch ? vidMatch[1] : 'unknown'

              const args = [path.join(clipperDir, 'local_clipper.py'), url, '--job-id', jobId]
              if (max_clips) { args.push('--max-clips', String(max_clips)) }
              if (min_duration) { args.push('--min-duration', String(min_duration)) }
              if (max_duration) { args.push('--max-duration', String(max_duration)) }
              args.push('--output-dir', path.join(clipsDir, videoId))
              if (reanalyze) { args.push('--reanalyze') }
              if (model_override) { args.push('--model-override', model_override) }

              // Create job in Convex immediately so dashboard shows it
              const convexSiteUrl = process.env.CONVEX_SITE_URL || 'https://veracious-sardine-771.convex.site'
              const createPayload: Record<string, string> = { jobId, videoUrl: url }
              // Always store the effective model for display (override → else read settings.json)
              if (model_override) {
                createPayload.model = model_override
              } else {
                try {
                  const sf = JSON.parse(fs.readFileSync(path.join(clipperDir, 'settings.json'), 'utf-8'))
                  createPayload.model = sf.model || 'google/gemini-2.0-flash-001'
                } catch { createPayload.model = 'google/gemini-2.0-flash-001' }
              }

              // Get oEmbed metadata for thumbnail/title
              try {
                const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
                const oRes = await (globalThis.fetch || require('node-fetch'))(oembedUrl)
                if (oRes.ok) {
                  const oembed = await oRes.json() as any
                  createPayload.videoTitle = oembed.title || ''
                  createPayload.channel = oembed.author_name || ''
                  createPayload.thumbnail = videoId !== 'unknown'
                    ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
                    : oembed.thumbnail_url || ''
                }
              } catch {}

              // Fire-and-forget Convex create
              fetch(`${convexSiteUrl}/api/pipeline/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createPayload),
              }).catch(() => {})

              // Use full path since Node spawn doesn't inherit shell PATH
              const python = process.env.PYTHON_PATH || 'python3'
              const proc = spawn(python, args, { cwd: clipperDir, env: envVars, stdio: ['ignore', 'pipe', 'pipe'] })

              activeJobs.set(jobId, { id: jobId, process: proc, videoId, url, startedAt: new Date().toISOString() })

              let stderrBuf = ''
              proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); console.error(`[clipper:${jobId}] ${d.toString().trim()}`) })
              proc.stdout?.on('data', (d: Buffer) => { console.log(`[clipper:${jobId}] ${d.toString().trim()}`) })
              proc.on('close', (code) => { 
                console.log(`[clipper:${jobId}] exited code=${code}`)
                if (stderrBuf) console.error(`[clipper:${jobId}] stderr: ${stderrBuf.slice(0, 500)}`)
                activeJobs.delete(jobId) 
              })
              proc.on('error', (err) => { console.error(`[clipper:${jobId}] spawn error:`, err); activeJobs.delete(jobId) })

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, jobId, pid: proc.pid, videoId }))
            } catch (e: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
          return
        })

        // POST /api/stop - stop a specific job or all
        server.middlewares.use('/api/stop', (req, res) => {
          if (req.method !== 'POST' && req.method !== 'DELETE') { res.statusCode = 405; res.end('Method not allowed'); return }
          let body = ''
          req.on('data', (c: Buffer) => body += c)
          req.on('end', () => {
            let jobId: string | undefined
            try { jobId = JSON.parse(body).jobId } catch {}

            if (jobId) {
              const job = activeJobs.get(jobId)
              if (job) {
                job.process.kill('SIGTERM')
                activeJobs.delete(jobId)
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, message: `Job ${jobId} stopped` }))
              } else {
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, message: 'Job not found' }))
              }
            } else {
              // Stop all jobs
              for (const [id, job] of activeJobs) {
                job.process.kill('SIGTERM')
                activeJobs.delete(id)
              }
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, message: 'All jobs stopped' }))
            }
          })
          return
        })

        // DELETE /api/delete-job — remove job from Convex + R2 + local files
        server.middlewares.use('/api/delete-job', (req, res) => {
          if (req.method !== 'POST' && req.method !== 'DELETE') { res.statusCode = 405; res.end('Method not allowed'); return }
          let body = ''
          req.on('data', (c: Buffer) => body += c)
          req.on('end', async () => {
            try {
              const { jobId, clips = [], videoId } = JSON.parse(body)
              if (!jobId) { res.statusCode = 400; res.end(JSON.stringify({ error: 'jobId required' })); return }

              const results: string[] = []

              // 1. Delete R2 clips (wrangler r2 object delete)
              const envVars = { ...process.env }
              try {
                const zshrc = fs.readFileSync(path.join(process.env.HOME!, '.zshrc'), 'utf-8')
                for (const match of zshrc.matchAll(/export\s+(\w+)="([^"]*)"/g)) {
                  envVars[match[1]] = match[2]
                }
              } catch {}

              for (const clip of clips) {
                const fname = clip.filename || path.basename(clip.path || '')
                if (!fname) continue
                const vid = videoId || 'unknown'
                const r2Key = `clipper-clips/default/${vid}/${fname}`
                try {
                  const { spawnSync } = await import('child_process')
                  const result = spawnSync('wrangler', ['r2', 'object', 'delete', r2Key], { env: envVars, encoding: 'utf-8' })
                  if (result.status === 0) {
                    results.push(`R2 deleted: ${fname}`)
                  } else {
                    results.push(`R2 skip/error: ${fname}`)
                  }
                } catch { results.push(`R2 error: ${fname}`) }

                // Also delete local file
                if (clip.path) {
                  try { fs.unlinkSync(clip.path) } catch {}
                }
              }

              // Delete local pipeline state file
              try { fs.unlinkSync(path.join(clipperDir, `pipeline_state_${jobId}.json`)) } catch {}

              // 2. Delete from Convex
              try {
                const convexCloudUrl = process.env.CONVEX_CLOUD_URL || 'https://veracious-sardine-771.convex.cloud'
                const resp = await fetch(`${convexCloudUrl}/api/mutation`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: 'jobs:remove', args: { jobId }, format: 'json' }),
                })
                const data = await resp.json() as any
                if (data.status === 'success') results.push('Convex deleted')
              } catch { results.push('Convex error') }

              // 3. Remove from local history file
              try {
                const histFile = path.join(clipperDir, 'pipeline_history.json')
                let hist: any[] = []
                try { hist = JSON.parse(fs.readFileSync(histFile, 'utf-8')) } catch {}
                hist = hist.filter((h: any) => h.id !== jobId)
                fs.writeFileSync(histFile, JSON.stringify(hist, null, 2))
                results.push('History updated')
              } catch {}

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, results }))
            } catch (e: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
          return
        })

        // GET /api/clips/:filename - serve video files
        server.middlewares.use('/api/clips/', (req, res) => {
          const filename = decodeURIComponent(req.url!.replace(/^\//, '').split('?')[0])
          if (!filename || filename.includes('..')) {
            res.statusCode = 400
            res.end('Bad request')
            return
          }
          const filePath = path.join(clipsDir, filename)
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404
            res.end('Not found')
            return
          }
          const stat = fs.statSync(filePath)
          res.setHeader('Content-Type', 'video/mp4')
          res.setHeader('Content-Length', stat.size)
          res.setHeader('Accept-Ranges', 'bytes')

          const range = req.headers.range
          if (range) {
            const parts = range.replace(/bytes=/, '').split('-')
            const start = parseInt(parts[0], 10)
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
            res.setHeader('Content-Length', end - start + 1)
            fs.createReadStream(filePath, { start, end }).pipe(res)
          } else {
            fs.createReadStream(filePath).pipe(res)
          }
        })
      }
    }
  ],
  server: { port: 5176, host: true, strictPort: true }
})
