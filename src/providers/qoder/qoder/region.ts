/**
 * The Qoder service deployment a transport instance is pinned to for its whole
 * lifetime: endpoint hosts, image publication and the job-token exchange are all
 * selected from this value when the instance is built.
 */
export type QoderRegion = 'global' | 'china'
