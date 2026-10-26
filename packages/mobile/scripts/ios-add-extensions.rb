#!/usr/bin/env ruby
# Adds the Share Extension and Widgets extension targets (and the app-local plugin sources) to the
# Xcode project, the same way the NotificationService target was added. Idempotent: safe to re-run.
#   GEM_PATH=~/.local/share/gem/ruby/4.0.0 ruby scripts/ios-add-extensions.rb
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
project = Xcodeproj::Project.open(File.join(ROOT, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' }
ns = project.targets.find { |t| t.name == 'NotificationService' }
main = project.main_group

def group_for(project, name, path)
  project.main_group[name] || project.main_group.new_group(name, path)
end

def ensure_file(group, name)
  group.files.find { |f| f.path == name } || group.new_file(name)
end

def add_source(target, ref)
  target.add_file_references([ref]) unless target.source_build_phase.files_references.include?(ref)
end

# App-local plugins live in the App group.
app_group = main['App']
%w[SpeechRecognitionPlugin.swift AppGroupPlugin.swift].each { |n| add_source(app, ensure_file(app_group, n)) }

shared = main['Shared']
shared_files = %w[AppGroup.swift RunActivityAttributes.swift].map { |n| ensure_file(shared, n) }
add_source(app, shared_files[0])
add_source(app, shared_files[1])

embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' }

def add_extension(project, app, ns, embed, name:, bundle_id:, sources:, shared_refs:, deployment:)
  return if project.targets.any? { |t| t.name == name }
  group = group_for(project, name, name)
  target = project.new_target(:app_extension, name, :ios, deployment)
  sources.each { |s| add_source(target, ensure_file(group, s)) }
  shared_refs.each { |r| add_source(target, r) }
  ensure_file(group, 'Info.plist')
  ensure_file(group, "#{name}.entitlements")
  target.build_configurations.each do |cfg|
    template = ns.build_configurations.find { |c| c.name == cfg.name }.build_settings
    cfg.build_settings.merge!(template)
    cfg.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = bundle_id
    cfg.build_settings['CODE_SIGN_ENTITLEMENTS'] = "#{name}/#{name}.entitlements"
    cfg.build_settings['INFOPLIST_FILE'] = "#{name}/Info.plist"
    cfg.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = deployment
    cfg.build_settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
  end
  app.add_dependency(target)
  build_file = embed.add_file_reference(target.product_reference, true)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

add_extension(project, app, ns, embed,
              name: 'ShareExtension', bundle_id: 'com.xische.dorabotremote.ShareExtension',
              sources: %w[ShareViewController.swift], shared_refs: [shared_files[0]], deployment: '15.0')
# ActivityKit's Live Activity API needs iOS 16.2; the widget extension simply is not offered below that.
add_extension(project, app, ns, embed,
              name: 'Widgets', bundle_id: 'com.xische.dorabotremote.Widgets',
              sources: %w[WidgetsBundle.swift PendingWidget.swift RunLiveActivity.swift], shared_refs: shared_files, deployment: '16.2')

project.save
