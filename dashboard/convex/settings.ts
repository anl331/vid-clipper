import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "global")).first();
  },
});

export const save = mutation({
  args: {
    model: v.string(),
    maxClips: v.number(),
    minDuration: v.number(),
    maxDuration: v.number(),
    transcriptionProvider: v.string(),
    openrouterApiKey: v.optional(v.string()),
    groqApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "global")).first();
    const data = { ...args, keysEncrypted: true };
    if (existing) {
      await ctx.db.patch(existing._id, data);
      return existing._id;
    }
    return await ctx.db.insert("settings", { key: "global", ...data });
  },
});
