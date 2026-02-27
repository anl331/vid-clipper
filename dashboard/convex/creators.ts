import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("creators").collect();
  },
});

export const add = mutation({
  args: {
    name: v.string(),
    youtubeHandle: v.string(),
    channelId: v.optional(v.string()),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("creators", {
      ...args,
      videosClipped: 0,
    });
  },
});

export const remove = mutation({
  args: { youtubeHandle: v.string() },
  handler: async (ctx, { youtubeHandle }) => {
    const creator = await ctx.db.query("creators").withIndex("by_handle", (q) => q.eq("youtubeHandle", youtubeHandle)).first();
    if (creator) await ctx.db.delete(creator._id);
  },
});

export const updateScanned = mutation({
  args: { youtubeHandle: v.string() },
  handler: async (ctx, { youtubeHandle }) => {
    const creator = await ctx.db.query("creators").withIndex("by_handle", (q) => q.eq("youtubeHandle", youtubeHandle)).first();
    if (creator) {
      await ctx.db.patch(creator._id, {
        lastScanned: new Date().toISOString(),
        videosClipped: (creator.videosClipped || 0) + 1,
      });
    }
  },
});
