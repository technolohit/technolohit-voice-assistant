# Mirrors .github/workflows/ci.yml dialogue scenario list (use: node, not npm on Windows).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

$scenarios = @(
  "sales_voice_agent_pitch_no_early_phone",
  "sales_customer_type_stt_kundenprojekt",
  "sales_customer_type_first_option",
  "sales_customer_type_own_company_plural",
  "sales_explanation_after_pitch",
  "sales_new_prospect_qualification",
  "sales_existing_customer_path",
  "v3_live_customer_type_loop",
  "v3_fuer_meine_firma",
  "v3_repeated_unclear_no_loop",
  "v3_rag_fail_closed_explanation",
  "v3_explanation_then_phone_handoff",
  "voice_agent_ki_assistent",
  "voice_agent_telefonassistent",
  "rueckruf_input_maps_to_phone",
  "no_rueckruf_output",
  "unclear_input",
  "unknown_intent",
  "five_products_overview",
  "contact_form_question",
  "email_contents_question"
)

foreach ($scenario in $scenarios) {
  Write-Host "Running dialogue QA scenario: $scenario"
  node scripts/qa-dialogue-text.js --scenario $scenario
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "All $($scenarios.Count) dialogue QA scenarios passed."
