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
