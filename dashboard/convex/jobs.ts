import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// Get all jobs, optionally filtered by status
export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    if (status) {
      return await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", status)).order("desc").collect();
    }
    return await ctx.db.query("jobs").order("desc").collect();
  },
});

// Get a single job by jobId
export const get = query({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    return await ctx.db.query("jobs").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).first();
  },
});

// Get active jobs (not done, not error)
export const active = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("jobs").order("desc").collect();
    return all.filter((j) => j.status !== "done" && j.status !== "error" && j.status !== "idle");
  },
});

// Create a new job
export const create = mutation({
  args: {
    jobId: v.string(),
    videoUrl: v.string(),
    videoTitle: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    channel: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("jobs", {
      ...args,
      status: "downloading",
      clipsCount: 0,
      startedAt: new Date().toISOString(),
      steps: {},
      logs: [],
      clips: [],
    });
  },
});

// Update job state (called by pipeline as it progresses)
export const update = mutation({
  args: {
    jobId: v.string(),
    status: v.optional(v.string()),
    videoTitle: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    channel: v.optional(v.string()),
    error: v.optional(v.string()),
    clipsCount: v.optional(v.number()),
    endedAt: v.optional(v.string()),
    steps: v.optional(v.any()),
    logs: v.optional(v.array(v.object({
      timestamp: v.string(),
      level: v.string(),
      message: v.string(),
    }))),
    clips: v.optional(v.array(v.object({
      filename: v.string(),
      title: v.string(),
      duration: v.number(),
      sizeBytes: v.number(),
      path: v.string(),
    }))),
  },
  handler: async (ctx, { jobId, ...updates }) => {
    const job = await ctx.db.query("jobs").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).first();
    if (!job) return null;
    // Filter out undefined values
    const patch: Record<string, any> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(job._id, patch);
    return job._id;
  },
});

// Append a log entry to a job
export const appendLog = mutation({
  args: {
    jobId: v.string(),
    timestamp: v.string(),
    level: v.string(),
    message: v.string(),
  },
  handler: async (ctx, { jobId, timestamp, level, message }) => {
    const job = await ctx.db.query("jobs").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).first();
    if (!job) return;
    await ctx.db.patch(job._id, {
      logs: [...job.logs, { timestamp, level, message }],
    });
  },
});

// Clear jobs by status
export const clearByStatus = mutation({
  args: { status: v.string() },
  handler: async (ctx, { status }) => {
    const jobs = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", status)).collect();
    for (const job of jobs) {
      await ctx.db.delete(job._id);
    }
    return jobs.length;
  },
});

// Delete a single job
export const remove = mutation({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.query("jobs").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).first();
    if (job) await ctx.db.delete(job._id);
  },
});
