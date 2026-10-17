{{- define "platform.name" -}}
platform
{{- end -}}

{{- define "platform.apiName" -}}
{{ include "platform.name" . }}-api
{{- end -}}

{{- define "platform.gatewayEncKeySecret" -}}
{{ .Values.gateway.encKey.existingSecret | default "gateway-enc-key" }}
{{- end -}}

{{- define "platform.dashboardName" -}}
{{ include "platform.name" . }}-dashboard
{{- end -}}

{{/*
API server endpoint(s) as pods reach them, "ip:port[,ip:port]", read from default/kubernetes at
install time. Empty under `helm template` (no cluster); the API then falls back to common ports.
*/}}
{{- define "platform.apiServerEndpoints" -}}
{{- $out := list -}}
{{- $ep := lookup "v1" "Endpoints" "default" "kubernetes" -}}
{{- if $ep -}}
{{- range $ep.subsets -}}
{{- $ports := .ports -}}
{{- range .addresses -}}
{{- $ip := .ip -}}
{{- range $ports -}}
{{- $out = append $out (printf "%s:%v" $ip .port) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- join "," $out -}}
{{- end -}}

{{/* ClusterRole bound in each store namespace for the provisioner's Helm job (ROADMAP S6). */}}
{{- define "platform.storeInstallerRole" -}}
{{ include "platform.name" . }}-store-installer
{{- end -}}

{{/* Platform database (DESIGN §13.3). */}}
{{- define "platform.postgresName" -}}
{{ include "platform.name" . }}-postgres
{{- end -}}

{{- define "platform.postgresSecret" -}}
{{ .Values.postgres.existingSecret | default (include "platform.postgresName" .) }}
{{- end -}}

{{/*
DATABASE_URL for the API and its init container. The password comes from the Secret through the
DATABASE_PASSWORD variable defined just before it (Kubernetes expands $(VAR) in env values), so it
is never written into values or the manifest.
*/}}
{{- define "platform.databaseEnv" -}}
- name: DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "platform.postgresSecret" . }}
      key: password
- name: DATABASE_URL
  value: "postgres://{{ .Values.postgres.user }}:$(DATABASE_PASSWORD)@{{ include "platform.postgresName" . }}:5432/{{ .Values.postgres.database }}"
{{- end -}}
