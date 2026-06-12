// SPIKE: compile-time @rpc codegen via a custom SWC transform pass.
//
// Proves the "embedded transpiler is a programmable compiler, not just a
// type-stripper" claim: a custom VisitMut pass — the same shape that drops into
// the real pipeline's `passes` tuple via visit_mut_pass() — rewrites a marker
// call `__rpc(name, mode)` into the GodotJS runtime registration
// `jsb.internal.add_script_rpc(this, name, { mode })` at transpile time,
// eliding the decorator runtime. The runtime target is the already-stable
// jsb.internal.add_script_* surface, so this is mechanical AST construction.
//
// Run:  cargo test --test rpc_codegen_spike -- --nocapture

use swc_core::common::{sync::Lrc, FileName, SourceMap, SyntaxContext, DUMMY_SP};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config, Emitter};
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

struct RpcCodegen {
    rewrites: usize,
}

fn ident(sym: &str) -> Ident {
    Ident {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        sym: sym.into(),
        optional: false,
    }
}

fn ident_name(sym: &str) -> IdentName {
    IdentName {
        span: DUMMY_SP,
        sym: sym.into(),
    }
}

fn member(obj: Expr, prop: &str) -> Expr {
    Expr::Member(MemberExpr {
        span: DUMMY_SP,
        obj: Box::new(obj),
        prop: MemberProp::Ident(ident_name(prop)),
    })
}

impl VisitMut for RpcCodegen {
    fn visit_mut_call_expr(&mut self, call: &mut CallExpr) {
        call.visit_mut_children_with(self);

        let is_rpc = matches!(&call.callee, Callee::Expr(e)
            if matches!(&**e, Expr::Ident(id) if id.sym.as_ref() == "__rpc"));
        if !(is_rpc && call.args.len() == 2) {
            return;
        }

        let name = call.args[0].clone();
        let mode = call.args[1].clone();

        // callee: jsb.internal.add_script_rpc
        let callee = member(member(Expr::Ident(ident("jsb")), "internal"), "add_script_rpc");

        // config: { mode: <mode> }
        let cfg = Expr::Object(ObjectLit {
            span: DUMMY_SP,
            props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                key: PropName::Ident(ident_name("mode")),
                value: mode.expr,
            })))],
        });

        call.callee = Callee::Expr(Box::new(callee));
        call.args = vec![
            ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::This(ThisExpr { span: DUMMY_SP })),
            },
            name,
            ExprOrSpread {
                spread: None,
                expr: Box::new(cfg),
            },
        ];
        self.rewrites += 1;
    }
}

fn transform_rpc(src: &str) -> (String, usize) {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(Lrc::new(FileName::Custom("rpc.ts".into())), src.to_string());

    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax::default()),
        EsVersion::Es2022,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    let mut program = parser.parse_program().expect("parse");

    let mut v = RpcCodegen { rewrites: 0 };
    program.visit_mut_with(&mut v);

    let mut buf = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut buf, None);
        let mut emitter = Emitter {
            cfg: Config::default(),
            cm: cm.clone(),
            comments: None,
            wr: writer,
        };
        emitter.emit_program(&program).expect("emit");
    }
    (String::from_utf8(buf).unwrap(), v.rewrites)
}

#[test]
fn rewrites_rpc_marker_to_add_script_rpc() {
    let src = "class Player {\n  fire() {\n    __rpc(\"fire\", \"any_peer\");\n  }\n}\n";
    let (out, n) = transform_rpc(src);
    println!("\n=== INPUT (.ts) ===\n{src}\n=== OUTPUT (.js) ===\n{out}\n=== rewrites: {n} ===\n");
    assert_eq!(n, 1, "expected exactly one __rpc rewrite");
    assert!(out.contains("jsb.internal.add_script_rpc"), "generated call missing");
    assert!(out.contains("mode:"), "config object missing");
    assert!(!out.contains("__rpc("), "marker call not removed");
}
