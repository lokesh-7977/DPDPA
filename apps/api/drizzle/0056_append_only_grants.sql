-- Least privilege for the app role: append-only tables (already guarded by triggers) can't even
-- be updated or deleted by dpdpa_app. Owner-run maintenance is unaffected.
REVOKE UPDATE, DELETE ON
  audit_log,
  auditor_access_log,
  breach_board_notices,
  breach_events,
  breach_evidence,
  domain_checks,
  policy_attestations,
  program_profiles,
  rights_request_events,
  risk_events,
  trust_center_snapshots,
  integration_syncs
FROM dpdpa_app;
--> statement-breakpoint
-- Contracts: the signed copy is attached once (UPDATE stays), never deleted.
REVOKE DELETE ON vendor_contracts FROM dpdpa_app;
--> statement-breakpoint
-- Records that are closed / superseded / revoked, never deleted (their triggers block it too).
REVOKE DELETE ON
  risks,
  assessments,
  dpia_versions,
  ai_system_versions,
  notice_versions,
  processing_activity_versions,
  access_reviews,
  access_review_items,
  scan_authorizations,
  auditor_rooms,
  auditor_grants,
  control_evidence,
  questionnaires,
  questionnaire_items,
  training_assignments,
  vendor_assessments
FROM dpdpa_app;
