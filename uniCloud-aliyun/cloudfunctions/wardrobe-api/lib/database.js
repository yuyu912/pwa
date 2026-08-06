"use strict";

const COLLECTIONS = Object.freeze({
  users: "wr_users",
  invites: "wr_invites",
  clothing: "wr_clothing_items",
  wearLogs: "wr_wear_logs",
  candidates: "wr_candidates",
  imageEmbeddings: "wr_image_embeddings",
  drafts: "wr_image_drafts",
  aiUsage: "wr_ai_usage_events",
  aiBudget: "wr_ai_budget",
  aiProviderSlots: "wr_ai_provider_slots",
  starAccounts: "wr_star_accounts",
  starEvents: "wr_star_events",
  outfitRequests: "wr_outfit_requests",
  outfitResponses: "wr_outfit_responses",
  outfitCaptures: "wr_outfit_capture_tasks",
  outfitRecords: "wr_outfit_records",
  trendSamples: "wr_trend_samples",
  communityPosts: "wr_community_posts",
  communityLikes: "wr_community_likes",
  complaints: "wr_complaints"
});

const database = () => uniCloud.database();
const collection = (source, name) => source.collection(COLLECTIONS[name]);
const normalizeDocument = (document) => document ? { ...document, id: String(document._id) } : null;
const normalizeGet = (result) => {
  if (!result?.data) return null;
  return normalizeDocument(Array.isArray(result.data) ? result.data[0] : result.data);
};

const getByIdFrom = async (source, name, id) => {
  if (id === undefined || id === null || id === "") return null;
  return normalizeGet(await collection(source, name).doc(String(id)).get());
};

const addTo = async (source, name, document, id) => {
  const recordId = String(id);
  await collection(source, name).add({ ...document, _id: recordId });
  return recordId;
};

const updateIn = async (source, name, id, changes) => {
  const result = await collection(source, name).doc(String(id)).update(changes);
  return Number(result.updated || result.affectedDocs || 0);
};

const removeFrom = async (source, name, id) => {
  const result = await collection(source, name).doc(String(id)).remove();
  return Number(result.deleted || result.affectedDocs || 0);
};

const findOne = async (name, where, options = {}) => {
  let query = collection(database(), name).where(where);
  if (options.orderBy) query = query.orderBy(options.orderBy, options.order || "desc");
  const result = await query.limit(1).get();
  return normalizeDocument(result.data?.[0]);
};

const findMany = async (name, where = {}, options = {}) => {
  let query = collection(database(), name).where(where);
  if (options.orderBy) query = query.orderBy(options.orderBy, options.order || "desc");
  if (options.limit) query = query.limit(options.limit);
  const result = await query.get();
  return (result.data || []).map(normalizeDocument);
};

const count = async (name, where = {}) => {
  const result = await collection(database(), name).where(where).count();
  return Number(result.total || 0);
};

const withTransaction = async (work) => {
  const transaction = await database().startTransaction();
  const tx = {
    getById: (name, id) => getByIdFrom(transaction, name, id),
    add: (name, document, id) => addTo(transaction, name, document, id),
    update: (name, id, changes) => updateIn(transaction, name, id, changes),
    remove: (name, id) => removeFrom(transaction, name, id)
  };
  try {
    const result = await work(tx);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
};

module.exports = {
  COLLECTIONS,
  command: () => database().command,
  getById: (name, id) => getByIdFrom(database(), name, id),
  add: (name, document, id) => addTo(database(), name, document, id),
  update: (name, id, changes) => updateIn(database(), name, id, changes),
  remove: (name, id) => removeFrom(database(), name, id),
  findOne,
  findMany,
  count,
  withTransaction
};
