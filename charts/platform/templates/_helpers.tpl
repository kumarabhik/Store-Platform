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
