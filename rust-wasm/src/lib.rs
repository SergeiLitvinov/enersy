use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn snap_to_grid(x: f64, y: f64, grid_size: f64) -> Vec<f64> {
    let snapped_x = (x / grid_size).round() * grid_size;
    let snapped_y = (y / grid_size).round() * grid_size;
    vec![snapped_x, snapped_y]
}

#[wasm_bindgen]
pub fn distance(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt()
}

#[wasm_bindgen]
pub fn normalize_angle(degrees: f64) -> f64 {
    let mut a = degrees % 360.0;
    if a < 0.0 {
        a += 360.0;
    }
    a
}

#[wasm_bindgen]
pub fn rotate_point(x: f64, y: f64, cx: f64, cy: f64, angle_deg: f64) -> Vec<f64> {
    let rad = angle_deg.to_radians();
    let cos = rad.cos();
    let sin = rad.sin();
    let dx = x - cx;
    let dy = y - cy;
    vec![
        cx + dx * cos - dy * sin,
        cy + dx * sin + dy * cos,
    ]
}

#[wasm_bindgen]
pub fn is_graph_connected(node_count: usize, edges_flat: Vec<u32>) -> bool {
    if node_count == 0 {
        return true;
    }

    let mut adj: Vec<Vec<usize>> = vec![vec![]; node_count];
    for chunk in edges_flat.chunks(2) {
        if chunk.len() < 2 {
            break;
        }
        let u = chunk[0] as usize;
        let v = chunk[1] as usize;
        if u < node_count && v < node_count {
            adj[u].push(v);
            adj[v].push(u);
        }
    }

    let mut visited = vec![false; node_count];
    let mut stack = vec![0usize];
    visited[0] = true;

    while let Some(u) = stack.pop() {
        for &v in &adj[u] {
            if !visited[v] {
                visited[v] = true;
                stack.push(v);
            }
        }
    }

    visited.iter().all(|&v| v)
}

#[wasm_bindgen]
pub fn has_cycles(node_count: usize, edges_flat: Vec<u32>) -> bool {
    let mut adj: Vec<Vec<usize>> = vec![vec![]; node_count];
    for chunk in edges_flat.chunks(2) {
        if chunk.len() < 2 {
            break;
        }
        let u = chunk[0] as usize;
        let v = chunk[1] as usize;
        if u < node_count && v < node_count {
            adj[u].push(v);
            adj[v].push(u);
        }
    }

    let mut visited = vec![false; node_count];

    fn dfs(u: usize, parent: usize, adj: &[Vec<usize>], visited: &mut [bool]) -> bool {
        visited[u] = true;
        for &v in &adj[u] {
            if !visited[v] {
                if dfs(v, u, adj, visited) {
                    return true;
                }
            } else if v != parent {
                return true;
            }
        }
        false
    }

    for i in 0..node_count {
        if !visited[i] {
            if dfs(i, usize::MAX, &adj, &mut visited) {
                return true;
            }
        }
    }

    false
}

fn is_switch(t: &str) -> bool {
    matches!(t, "breaker" | "disconnector" | "grounding_switch")
}

fn is_transformer(t: &str) -> bool {
    matches!(t, "transformer" | "transformer_3w" | "autotransformer")
}

fn can_connect_to_busbar(t: &str) -> bool {
    matches!(
        t,
        "generator"
            | "transformer"
            | "transformer_3w"
            | "autotransformer"
            | "transmission_line"
            | "breaker"
            | "disconnector"
            | "grounding_switch"
            | "load"
            | "ground"
            | "capacitor"
            | "reactor"
    )
}

#[wasm_bindgen]
pub fn validate_connection(type_a: &str, type_b: &str) -> bool {
    let a = type_a.trim().to_lowercase();
    let b = type_b.trim().to_lowercase();

    if a == "busbar" && can_connect_to_busbar(&b) {
        return true;
    }
    if b == "busbar" && can_connect_to_busbar(&a) {
        return true;
    }
    if is_switch(&a) && is_switch(&b) {
        return true;
    }
    if is_transformer(&a) && is_switch(&b) {
        return true;
    }
    if is_switch(&a) && is_transformer(&b) {
        return true;
    }
    if (a == "transmission_line" && b == "transmission_line")
        || (a == "transmission_line" && is_switch(&b))
        || (is_switch(&a) && b == "transmission_line")
    {
        return true;
    }
    if (a == "generator" && b == "breaker")
        || (a == "breaker" && b == "generator")
    {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snap_to_grid() {
        let result = snap_to_grid(17.0, 33.0, 20.0);
        assert!((result[0] - 20.0).abs() < f64::EPSILON);
        assert!((result[1] - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_snap_to_grid_exact() {
        let result = snap_to_grid(20.0, 40.0, 20.0);
        assert!((result[0] - 20.0).abs() < f64::EPSILON);
        assert!((result[1] - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_distance() {
        let d = distance(0.0, 0.0, 3.0, 4.0);
        assert!((d - 5.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_distance_zero() {
        let d = distance(1.0, 2.0, 1.0, 2.0);
        assert!((d - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_normalize_angle() {
        assert!((normalize_angle(450.0) - 90.0).abs() < f64::EPSILON);
        assert!((normalize_angle(-90.0) - 270.0).abs() < f64::EPSILON);
        assert!((normalize_angle(0.0) - 0.0).abs() < f64::EPSILON);
        assert!((normalize_angle(360.0) - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_rotate_point_90_deg() {
        let result = rotate_point(1.0, 0.0, 0.0, 0.0, 90.0);
        assert!((result[0] - 0.0).abs() < 1e-10);
        assert!((result[1] - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_rotate_point_180_deg() {
        let result = rotate_point(1.0, 0.0, 0.0, 0.0, 180.0);
        assert!((result[0] - -1.0).abs() < 1e-10);
        assert!((result[1] - 0.0).abs() < 1e-10);
    }

    #[test]
    fn test_rotate_point_around_center() {
        let result = rotate_point(5.0, 5.0, 5.0, 5.0, 45.0);
        assert!((result[0] - 5.0).abs() < 1e-10);
        assert!((result[1] - 5.0).abs() < 1e-10);
    }

    #[test]
    fn test_graph_connected_single_node() {
        assert!(is_graph_connected(1, vec![]));
    }

    #[test]
    fn test_graph_connected_two_nodes() {
        assert!(is_graph_connected(2, vec![0, 1]));
    }

    #[test]
    fn test_graph_disconnected() {
        assert!(!is_graph_connected(3, vec![0, 1]));
    }

    #[test]
    fn test_graph_connected_line() {
        assert!(is_graph_connected(3, vec![0, 1, 1, 2]));
    }

    #[test]
    fn test_graph_connected_star() {
        assert!(is_graph_connected(4, vec![0, 1, 0, 2, 0, 3]));
    }

    #[test]
    fn test_has_cycles_no_cycle() {
        assert!(!has_cycles(3, vec![0, 1, 1, 2]));
    }

    #[test]
    fn test_has_cycles_triangle() {
        assert!(has_cycles(3, vec![0, 1, 1, 2, 2, 0]));
    }

    #[test]
    fn test_has_cycles_self_loop() {
        assert!(has_cycles(1, vec![0, 0]));
    }

    #[test]
    fn test_has_cycles_empty() {
        assert!(!has_cycles(0, vec![]));
    }

    #[test]
    fn test_validate_busbar_generator() {
        assert!(validate_connection("busbar", "generator"));
        assert!(validate_connection("generator", "busbar"));
    }

    #[test]
    fn test_validate_busbar_load() {
        assert!(validate_connection("busbar", "load"));
        assert!(validate_connection("load", "busbar"));
    }

    #[test]
    fn test_validate_switch_switch() {
        assert!(validate_connection("breaker", "disconnector"));
        assert!(validate_connection("disconnector", "grounding_switch"));
    }

    #[test]
    fn test_validate_transformer_switch() {
        assert!(validate_connection("transformer", "breaker"));
        assert!(validate_connection("disconnector", "transformer"));
    }

    #[test]
    fn test_validate_line_switch() {
        assert!(validate_connection("transmission_line", "breaker"));
        assert!(validate_connection("disconnector", "transmission_line"));
    }

    #[test]
    fn test_validate_line_line() {
        assert!(validate_connection("transmission_line", "transmission_line"));
    }

    #[test]
    fn test_validate_generator_breaker() {
        assert!(validate_connection("generator", "breaker"));
        assert!(validate_connection("breaker", "generator"));
    }

    #[test]
    fn test_validate_invalid_generator_load() {
        assert!(!validate_connection("generator", "load"));
        assert!(!validate_connection("load", "generator"));
    }

    #[test]
    fn test_validate_invalid_transformer_load() {
        assert!(!validate_connection("transformer", "load"));
    }

    #[test]
    fn test_validate_invalid_unknown_type() {
        assert!(!validate_connection("generator", "unknown_type"));
    }

    #[test]
    fn test_validate_case_insensitive() {
        assert!(validate_connection("BusBar", "Generator"));
        assert!(validate_connection("TRANSMISSION_LINE", "BREAKER"));
    }

    #[test]
    fn test_validate_busbar_ground() {
        assert!(validate_connection("busbar", "ground"));
    }

    #[test]
    fn test_validate_busbar_capacitor() {
        assert!(validate_connection("busbar", "capacitor"));
    }

    #[test]
    fn test_validate_busbar_reactor() {
        assert!(validate_connection("busbar", "reactor"));
    }
}