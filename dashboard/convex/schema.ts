import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Clipping job history
  jobs: defineTable({
    jobId: v.string(), // 8-char hex
    videoUrl: v.string(),
    videoTitle: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    channel: v.optional(v.string()),
    status: v.string(), // "downloading" | "transcribing" | "analyzing" | "clipping" | "done" | "error"
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    clipsCount: v.number(),
    startedAt: v.optional(v.string()),
    endedAt: v.optional(v.string()),
    steps: v.any(), // Record<string, { started_at, ended_at, status }>
    logs: v.array(v.object({
      timestamp: v.string(),
      level: v.string(),
      message: v.string(),
    })),
    clips: v.array(v.object({
      filename: v.string(),
      title: v.string(),
      duration: v.number(),
      sizeBytes: v.number(),
      path: v.string(),
    })),
  })
    .index("by_status", ["status"])
    .index("by_jobId", ["jobId"]),

  // Tracked YouTube creators
  creators: defineTable({
    name: v.string(),
    youtubeHandle: v.string(),
    channelId: v.optional(v.string()),
    tags: v.array(v.string()),
    lastScanned: v.optional(v.string()),
    videosClipped: v.optional(v.number()),
  })
    .index("by_handle", ["youtubeHandle"]),

  // Pipeline settings (single row, upserted)
  settings: defineTable({
    key: v.string(), // always "global"
    model: v.string(),
    maxClips: v.number(),
    minDuration: v.number(),
    maxDuration: v.number(),
    transcriptionProvider: v.string(), // "groq" | "local"
    // API keys stored encrypted (AES-GCM, client-side encryption)
    openrouterApiKey: v.optional(v.string()),
    groqApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
    // Flag indicating keys are encrypted
    keysEncrypted: v.optional(v.boolean()),
  })
    .index("by_key", ["key"]),
});
