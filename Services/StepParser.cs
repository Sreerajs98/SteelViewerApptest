using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace SteelPackingApp.Services;

/// <summary>
/// A reference to another entity, e.g. "#123" in the raw IFC/STEP text.
/// Kept as its own type (rather than a plain int) so Unwrap's return value
/// can be told apart from an ordinary number.
/// </summary>
public class StepRef
{
    public int Id { get; }
    public StepRef(int id) { Id = id; }
}

/// <summary>
/// A minimal STEP (ISO-10303-21) parser - the plain-text format every IFC
/// file is written in. This is not a general-purpose IFC toolkit; it reads
/// exactly what this app needs (entity id, type, and its raw argument
/// list), which is enough to extract Tekla's property sets without taking
/// a dependency on a full IFC engine.
///
/// This logic was prototyped and validated in Python against a real 5MB
/// Tekla IFC export first (75,000+ entities) - the C# port below follows
/// that proven logic statement for statement.
/// </summary>
public static class StepParser
{
    /// <summary>
    /// Scans the whole file text once, splitting it into top-level
    /// ';'-terminated statements (respecting quoted strings and nested
    /// parentheses so neither can end a statement early), and keeps only
    /// the ones that look like "#id= TYPE(args)" entity instances - which
    /// automatically skips the HEADER section, since header statements
    /// don't have a leading "#digits=".
    /// </summary>
    public static Dictionary<int, (string Type, string ArgsRaw)> TokenizeEntities(string text)
    {
        var entities = new Dictionary<int, (string, string)>();
        var buf = new StringBuilder();
        int depth = 0;
        bool inString = false;
        int n = text.Length;
        var entityPattern = new Regex(@"^#(\d+)\s*=\s*([A-Z0-9_]+)\((.*)\)$", RegexOptions.Singleline);

        for (int i = 0; i < n; i++)
        {
            char c = text[i];
            if (inString)
            {
                buf.Append(c);
                if (c == '\'')
                {
                    if (i + 1 < n && text[i + 1] == '\'') { buf.Append(text[i + 1]); i++; }
                    else inString = false;
                }
            }
            else
            {
                if (c == '\'') { inString = true; buf.Append(c); }
                else if (c == '(') { depth++; buf.Append(c); }
                else if (c == ')') { depth--; buf.Append(c); }
                else if (c == ';' && depth == 0)
                {
                    string stmt = buf.ToString().Trim();
                    buf.Clear();
                    var m = entityPattern.Match(stmt);
                    if (m.Success)
                    {
                        int id = int.Parse(m.Groups[1].Value);
                        entities[id] = (m.Groups[2].Value, m.Groups[3].Value);
                    }
                }
                else
                {
                    buf.Append(c);
                }
            }
        }
        return entities;
    }

    /// <summary>
    /// Splits a STEP argument list on top-level commas only - a comma
    /// inside a quoted string or inside nested parentheses does not split.
    /// e.g. "'a,b'" is one token; "(#1,#2)" is one token.
    /// </summary>
    public static List<string> SplitTopLevel(string s)
    {
        var parts = new List<string>();
        var cur = new StringBuilder();
        int depth = 0;
        bool inString = false;
        int n = s.Length;

        for (int i = 0; i < n; i++)
        {
            char c = s[i];
            if (inString)
            {
                cur.Append(c);
                if (c == '\'')
                {
                    if (i + 1 < n && s[i + 1] == '\'') { cur.Append(s[i + 1]); i++; }
                    else inString = false;
                }
            }
            else
            {
                if (c == '\'') { inString = true; cur.Append(c); }
                else if (c == '(') { depth++; cur.Append(c); }
                else if (c == ')') { depth--; cur.Append(c); }
                else if (c == ',' && depth == 0)
                {
                    parts.Add(cur.ToString().Trim());
                    cur.Clear();
                }
                else cur.Append(c);
            }
        }
        if (cur.Length > 0) parts.Add(cur.ToString().Trim());
        return parts;
    }

    private static readonly Regex TypedWrapperPattern = new(@"^[A-Z0-9_]+\((.*)\)$", RegexOptions.Singleline);

    /// <summary>
    /// Turns one raw STEP argument token into a usable value:
    ///   $              -> null (STEP's "not provided")
    ///   *              -> null (STEP's "derived, not stored")
    ///   #123           -> StepRef(123)
    ///   (a,b,c)        -> List&lt;object?&gt; of the unwrapped items
    ///   'text'         -> string (STEP doubles an embedded quote as '')
    ///   .ENUMVALUE.    -> string ("ENUMVALUE")
    ///   TYPE(inner)    -> unwraps "inner" (e.g. IFCLABEL('x') -> "x",
    ///                     IFCMASSMEASURE(3.) -> 3.0)
    ///   plain number   -> double
    /// </summary>
    public static object? Unwrap(string? token)
    {
        if (token == null) return null;
        token = token.Trim();
        if (token.Length == 0 || token == "$" || token == "*") return null;

        if (token.StartsWith("#"))
            return int.TryParse(token.Substring(1), out int id) ? new StepRef(id) : null;

        if (token.StartsWith("(") && token.EndsWith(")"))
        {
            string inner = token.Substring(1, token.Length - 2);
            var list = new List<object?>();
            foreach (var t in SplitTopLevel(inner)) list.Add(Unwrap(t));
            return list;
        }

        if (token.StartsWith("'") && token.EndsWith("'") && token.Length >= 2)
        {
            string inner = token.Substring(1, token.Length - 2);
            return inner.Replace("''", "'");
        }

        if (token.StartsWith(".") && token.EndsWith(".") && token.Length >= 2)
            return token.Substring(1, token.Length - 2); // enum, e.g. .NOCHANGE.

        var m = TypedWrapperPattern.Match(token);
        if (m.Success)
        {
            var parts = SplitTopLevel(m.Groups[1].Value);
            if (parts.Count == 1) return Unwrap(parts[0]);
            var list = new List<object?>();
            foreach (var p in parts) list.Add(Unwrap(p));
            return list;
        }

        if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
            return d;

        return token; // fallback: return the raw text as-is
    }
}
