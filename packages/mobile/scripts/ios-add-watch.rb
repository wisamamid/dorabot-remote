#!/usr/bin/env ruby
# Adds the watchOS companion (WatchApp, a single-target SwiftUI watch app) and the phone-side
# WatchBridgePlugin source to the Xcode project, and embeds the watch app in the iOS app. Same approach
# as scripts/ios-add-extensions.rb. Idempotent: safe to re-run. Nothing here is touched by `cap sync`.
#   GEM_PATH=~/.local/share/gem/ruby/4.0.0 ruby scripts/ios-add-watch.rb
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
project = Xcodeproj::Project.open(File.join(ROOT, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' }
main = project.main_group

def add_source(target, ref)
  target.add_file_references([ref]) unless target.source_build_phase.files_references.include?(ref)
end

app_group = main['App']
plugin = app_group.files.find { |f| f.path == 'WatchBridgePlugin.swift' } || app_group.new_file('WatchBridgePlugin.swift')
add_source(app, plugin)

unless project.targets.any? { |t| t.name == 'WatchApp' }
  group = main['WatchApp'] || main.new_group('WatchApp', 'WatchApp')
  target = project.new_target(:application, 'WatchApp', :watchos, '10.0')
  %w[DorabotWatchApp.swift PhoneLink.swift InboxView.swift].each do |n|
    add_source(target, group.files.find { |f| f.path == n } || group.new_file(n))
  end
  group.files.find { |f| f.path == 'Info.plist' } || group.new_file('Info.plist')
  assets = group.files.find { |f| f.path == 'Assets.xcassets' } || group.new_file('Assets.xcassets')
  target.resources_build_phase.add_file_reference(assets, true)

  app_cfgs = app.build_configurations.to_h { |c| [c.name, c.build_settings] }
  target.build_configurations.each do |cfg|
    s = cfg.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.xische.dorabotremote.watchkitapp'
    s['PRODUCT_NAME'] = 'WatchApp'
    s['INFOPLIST_FILE'] = 'WatchApp/Info.plist'
    s['SDKROOT'] = 'watchos'
    s['SUPPORTED_PLATFORMS'] = 'watchos watchsimulator'
    s['TARGETED_DEVICE_FAMILY'] = '4'
    s['WATCHOS_DEPLOYMENT_TARGET'] = '10.0'
    s['SWIFT_VERSION'] = '5.0'
    s['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
    s['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_STYLE'] = 'Automatic'
    s['DEVELOPMENT_TEAM'] = '6JE2QNN9JG'
    s['SKIP_INSTALL'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks']
    %w[MARKETING_VERSION CURRENT_PROJECT_VERSION].each { |k| s[k] = app_cfgs[cfg.name][k] || '1' }
  end

  app.add_dependency(target)
  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Watch Content' } ||
          app.new_copy_files_build_phase('Embed Watch Content')
  embed.symbol_dst_subfolder_spec = :products_directory
  embed.dst_path = '$(CONTENTS_FOLDER_PATH)/Watch'
  bf = embed.add_file_reference(target.product_reference, true)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

project.save
