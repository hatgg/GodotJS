#include "register_types.h"

#include "weaver/jsb_weaver.h"

#ifdef TOOLS_ENABLED
#include "weaver-editor/jsb_weaver_editor.h"
#endif

#include "godotjs_transpiler.h"

// M1 link-proof: transpile a literal .ts string and print the result at
// startup so the SCons → cargo → static-link path is end-to-end verified.
// Remove once M2 wires the real runtime loader call site.
static void jsb_m1_transpile_smoketest() {
    static const char kSource[] = "const x: number = 41; console.log(x + 1)";
    static const char kFilename[] = "<m1-smoketest>.ts";
    GodotJSTranspileResult* r = godotjs_transpile_ts(
        reinterpret_cast<const uint8_t*>(kSource), sizeof(kSource) - 1,
        reinterpret_cast<const uint8_t*>(kFilename), sizeof(kFilename) - 1,
        0);
    if (!r) {
        print_line("[GodotJS/M1] transpile returned null");
        return;
    }
    if (r->error) {
        print_line(vformat("[GodotJS/M1] transpile error: %s",
            String::utf8(reinterpret_cast<const char*>(r->error), int64_t(r->error_len))));
    } else if (r->code) {
        print_line(vformat("[GodotJS/M1] transpile ok (%d bytes):\n%s",
            int(r->code_len),
            String::utf8(reinterpret_cast<const char*>(r->code), int64_t(r->code_len))));
    }
    godotjs_free_transpile_result(r);
}

static Ref<ResourceFormatLoaderGodotJSScript> resource_loader_js;
static Ref<ResourceFormatSaverGodotJSScript> resource_saver_js;

void jsb_initialize_module(ModuleInitializationLevel p_level)
{
    if (p_level == MODULE_INITIALIZATION_LEVEL_SERVERS)
    {
        jsb_m1_transpile_smoketest();

        GDREGISTER_CLASS(GodotJSScript);
#ifdef TOOLS_ENABLED
        GDREGISTER_CLASS(GodotJSEditorHelper);
        GDREGISTER_CLASS(GodotJSEditorProgress);
#endif

        jsb::impl::GlobalInitialize::init();

        // register javascript language
        GodotJSScriptLanguage* script_language_js = memnew(GodotJSScriptLanguage());
        ScriptServer::register_language(script_language_js);

        resource_loader_js.instantiate();
        ResourceLoader::add_resource_format_loader(resource_loader_js);

        resource_saver_js.instantiate();
        ResourceSaver::add_resource_format_saver(resource_saver_js);

#ifdef TOOLS_ENABLED
        EditorPlugins::add_by_type<GodotJSEditorPlugin>();
#endif
    }
}

void jsb_uninitialize_module(ModuleInitializationLevel p_level)
{
    if (p_level == MODULE_INITIALIZATION_LEVEL_CORE)
    {
        ResourceLoader::remove_resource_format_loader(resource_loader_js);
        resource_loader_js.unref();

        ResourceSaver::remove_resource_format_saver(resource_saver_js);
        resource_saver_js.unref();

        GodotJSScriptLanguage *script_language_js = GodotJSScriptLanguage::get_singleton();
        jsb_check(script_language_js);
        ScriptServer::unregister_language(script_language_js);
        memdelete(script_language_js);
    }
}

#if JSB_GDEXTENSION
extern "C"
{
    GDExtensionBool GDE_EXPORT jsb_gdextension_init(GDExtensionInterfaceGetProcAddress p_get_proc_address, GDExtensionClassLibraryPtr p_library, GDExtensionInitialization* r_initialization)
    {
        GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);

        init_obj.register_initializer(jsb_initialize_module);
        init_obj.register_terminator(jsb_uninitialize_module);
        init_obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_CORE);

        return init_obj.init();
    }
}
#endif
