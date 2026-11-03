{{/* Namespace of the demo app (incident lab). */}}
{{- define "workshop.demoNamespace" -}}
{{- .Values.global.demoNamespace | default "demo" -}}
{{- end -}}

{{/* Shared monitoring namespace (Grafana, monitoring-reader). */}}
{{- define "workshop.monitoringNamespace" -}}
{{- .Values.global.monitoringNamespace | default "monitoring" -}}
{{- end -}}

{{/* Plaintext in-cluster gateway URL (http://openshell.<ns>.svc.cluster.local:8080). */}}
{{- define "workshop.gatewayUrl" -}}
{{- .Values.openshellGateway.endpointUrl | default (printf "http://openshell.%s.svc.cluster.local:8080" .Release.Namespace) -}}
{{- end -}}

{{- define "workshop.grafanaOrigin" -}}
{{- .Values.grafana.origin | default (printf "http://grafana.%s.svc.cluster.local:80" (include "workshop.monitoringNamespace" .)) -}}
{{- end -}}

{{/* Namespace whose event-exporter logs carry the demo namespace's events. */}}
{{- define "workshop.eventsNamespace" -}}
{{- if .Values.eventExporter.enabled -}}{{ .Release.Namespace }}{{- else -}}{{ include "workshop.monitoringNamespace" . }}{{- end -}}
{{- end -}}

{{- define "workshop.labels" -}}
app.kubernetes.io/name: workshop
app.kubernetes.io/part-of: nemoclaw
{{- with .Values.global.lab }}{{ if .user }}
lab.nemoclaw.io/user: {{ .user | quote }}
{{- end }}{{ end }}
{{- end -}}
