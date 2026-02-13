{{- define "platform.name" -}}
platform
{{- end -}}

{{- define "platform.apiName" -}}
{{ include "platform.name" . }}-api
{{- end -}}

{{- define "platform.dashboardName" -}}
{{ include "platform.name" . }}-dashboard
{{- end -}}
